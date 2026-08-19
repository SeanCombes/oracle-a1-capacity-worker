import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { nextAlarmDelayMilliseconds } from "../src/coordinator";
import type { AutomationState } from "../src/types";

describe("Worker endpoints and Cron routing", () => {
  it("retains deterministic delay calculations for legacy state", () => {
    const schedule = {
      jobPollMilliseconds: 120_000,
      transientRetryMilliseconds: 300_000,
    };

    expect(
      nextAlarmDelayMilliseconds(
        { outcome: "apply_created", message: "created" },
        schedule,
      ),
    ).toBe(120_000);
    expect(
      nextAlarmDelayMilliseconds(
        { outcome: "transient_error", message: "throttled" },
        schedule,
      ),
    ).toBe(300_000);
    expect(
      nextAlarmDelayMilliseconds(
        {
          outcome: "transient_error",
          message: "throttled",
          retryAfterMilliseconds: 1_000,
        },
        schedule,
      ),
    ).toBe(300_000);
    expect(
      nextAlarmDelayMilliseconds(
        {
          outcome: "transient_error",
          message: "throttled",
          retryAfterMilliseconds: 900_000,
        },
        schedule,
      ),
    ).toBe(900_000);
    expect(
      nextAlarmDelayMilliseconds(
        {
          outcome: "create_deferred",
          retryAfterMilliseconds: 42_000,
          message: "cooldown",
        },
        schedule,
      ),
    ).toBe(42_000);
    expect(
      nextAlarmDelayMilliseconds(
        { outcome: "meaningful_error", message: "paused" },
        schedule,
      ),
    ).toBeNull();
  });

  it("returns a secret-free health response", async () => {
    const response = await exports.default.fetch("https://worker.test/health");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("test-stack");
    expect(body).not.toContain("test-tenancy");
    expect(body).not.toContain("discord.com");
  });

  it("rejects unauthorized manual execution", async () => {
    const response = await exports.default.fetch("https://worker.test/run", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(response.status).toBe(401);
  });

  it("refuses authorized Cloudflare claim execution", async () => {
    const response = await exports.default.fetch("https://worker.test/run", {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
    });

    expect(response.status).toBe(409);
  });

  it("rejects malformed checker metrics before posting to Discord", async () => {
    const response = await exports.default.fetch("https://worker.test/notify", {
      method: "POST",
      headers: {
        authorization: "Bearer test-notify-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event: "heartbeat",
        content: "online",
        metrics: { checksRun: 1, ramPercent: 101, cpuPercent: 2, pollIntervalSeconds: 30 },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid metrics" });
  });

  it("allows an authorized reset", async () => {
    const response = await exports.default.fetch("https://worker.test/reset", {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ terminalSuccess: false });
  });

  it("discards a legacy alarm when a scheduled event arrives", async () => {
    const stub = env.DEPLOYMENT_COORDINATOR.getByName("primary");
    await runInDurableObject(stub, (_instance, state) => {
      const terminal: AutomationState = {
        terminalSuccess: true,
        successNotified: true,
        activeJobId: "redacted-test-job",
        lastLifecycleState: "SUCCEEDED",
        retryCount: 4,
        errorFingerprints: [],
        updatedAt: Date.now(),
      };
      state.storage.sql.exec(
        `INSERT INTO automation_state (id, json)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
        JSON.stringify(terminal),
      );
      state.storage.setAlarm(Date.now() + 60_000);
    });
    const controller = createScheduledController({
      cron: "*/20 * * * *",
      scheduledTime: Date.now(),
    });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    const status = await stub.status();

    expect(status.terminalSuccess).toBe(true);
    expect(status.retryCount).toBe(4);
    expect(status.nextCheckAt).toBeUndefined();
  });
});
