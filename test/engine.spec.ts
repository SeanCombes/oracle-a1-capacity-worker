import { describe, expect, it } from "vitest";
import { DeploymentEngine, RunGate, defaultState } from "../src/engine";
import { OciApiError } from "../src/oci-client";
import type {
  AutomationState,
  DiscordPort,
  OciClientPort,
  OciJob,
  StatePort,
} from "../src/types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function job(
  id: string,
  lifecycleState: OciJob["lifecycleState"],
  extra: Partial<OciJob> = {},
): OciJob {
  return {
    id,
    operation: "APPLY",
    lifecycleState,
    timeCreated: `2026-07-28T20:00:0${id.slice(-1)}.000Z`,
    ...extra,
  };
}

class FakeState implements StatePort {
  saves = 0;

  constructor(public value: AutomationState = defaultState(1_000)) {}

  async load(): Promise<AutomationState> {
    return clone(this.value);
  }

  async save(state: AutomationState): Promise<void> {
    this.saves += 1;
    this.value = clone(state);
  }
}

class FakeOci implements OciClientPort {
  jobs: OciJob[] = [];
  details = new Map<string, OciJob>();
  logs = new Map<string, string>();
  createCalls: string[] = [];
  detailCalls: string[] = [];
  logCalls: string[] = [];
  listError: Error | undefined;
  createError: Error | undefined;

  async listJobs(): Promise<OciJob[]> {
    if (this.listError) throw this.listError;
    return clone(this.jobs);
  }

  async getJob(jobId: string): Promise<OciJob> {
    this.detailCalls.push(jobId);
    const found = this.details.get(jobId) ?? this.jobs.find((item) => item.id === jobId);
    if (!found) throw new Error("Missing fake job");
    return clone(found);
  }

  async getJobLogsExcerpt(jobId: string): Promise<string> {
    this.logCalls.push(jobId);
    return this.logs.get(jobId) ?? "";
  }

  async createApplyJob(retryToken: string): Promise<OciJob> {
    this.createCalls.push(retryToken);
    if (this.createError) throw this.createError;
    return job("created-1", "ACCEPTED");
  }
}

class FakeDiscord implements DiscordPort {
  successes = 0;
  statuses: string[] = [];
  failures: Array<{ summary: string; fingerprint: string }> = [];
  failSuccess = false;
  failFailure = false;

  async sendSuccess(): Promise<void> {
    this.successes += 1;
    if (this.failSuccess) throw new Error("Discord unavailable");
  }

  async sendFailure(summary: string, fingerprint: string): Promise<void> {
    if (this.failFailure) throw new Error("Discord unavailable");
    this.failures.push({ summary, fingerprint });
  }

  async sendRunStatus(result: { outcome: string }): Promise<void> {
    this.statuses.push(result.outcome);
  }
}

function fixture(now = 10_000) {
  const state = new FakeState(defaultState(now));
  const oci = new FakeOci();
  const discord = new FakeDiscord();
  let clock = now;
  const engine = new DeploymentEngine(state, oci, discord, {
    leaseMilliseconds: 600_000,
    errorCooldownMilliseconds: 21_600_000,
    createCooldownMilliseconds: 300_000,
    now: () => clock,
    uuid: () => "fixed-retry-token",
  });
  return {
    state,
    oci,
    discord,
    engine,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

describe("DeploymentEngine", () => {
  it("creates one Apply job when no Apply job exists", async () => {
    const { engine, oci, state, discord } = fixture();

    const result = await engine.run("cron");

    expect(result.outcome).toBe("apply_created");
    expect(oci.createCalls).toEqual(["fixed-retry-token"]);
    expect(state.value.activeJobId).toBe("created-1");
    expect(state.value.pendingRetryToken).toBeUndefined();
    expect(discord.statuses).toEqual([]);
    expect(state.value.lastApplyCreatedAt).toBe(10_000);
  });

  it("keeps internal alarm checks quiet in Discord", async () => {
    const { engine, discord } = fixture();

    const result = await engine.run("alarm");

    expect(result.outcome).toBe("apply_created");
    expect(discord.statuses).toEqual([]);
  });

  it.each(["ACCEPTED", "IN_PROGRESS", "CANCELING"] as const)(
    "does not duplicate an active %s job",
    async (lifecycleState) => {
      const { engine, oci } = fixture();
      oci.jobs = [job("active-1", lifecycleState)];

      const result = await engine.run("cron");

      expect(result.outcome).toBe("job_active");
      expect(oci.createCalls).toHaveLength(0);
    },
  );

  it("recovers from stale local state when OCI already succeeded", async () => {
    const { engine, oci, discord, state, setClock } = fixture();
    oci.jobs = [job("success-1", "SUCCEEDED")];

    const first = await engine.run("cron");
    const second = await engine.run("cron");

    expect(first.outcome).toBe("terminal_success");
    expect(second.outcome).toBe("terminal_success");
    expect(discord.successes).toBe(1);
    expect(oci.createCalls).toHaveLength(0);
    expect(state.value.terminalSuccess).toBe(true);
    expect(state.value.successNotified).toBe(true);
  });

  it("retries repeated capacity failures with one status per run", async () => {
    const { engine, oci, discord, state, setClock } = fixture();
    const failed = job("failed-1", "FAILED");
    oci.jobs = [failed];
    oci.details.set(
      failed.id,
      job(failed.id, "FAILED", {
        failureDetails: {
          code: "TERRAFORM_EXECUTION_ERROR",
          message: "Compute launch failed",
        },
      }),
    );
    oci.logs.set(
      failed.id,
      `${"x".repeat(600)} Error: Out of host capacity for VM.Standard.A1.Flex`,
    );

    const result = await engine.run("cron");
    setClock(310_001);
    const secondFailed = job("failed-5", "FAILED");
    oci.jobs = [secondFailed];
    oci.details.set(
      secondFailed.id,
      job(secondFailed.id, "FAILED", {
        failureDetails: {
          code: "TERRAFORM_EXECUTION_ERROR",
          message: "Compute launch failed again",
        },
      }),
    );
    oci.logs.set(secondFailed.id, "InternalError: no available host");
    await engine.run("cron");

    expect(result.outcome).toBe("capacity_wait");
    expect(oci.createCalls).toHaveLength(2);
    expect(discord.failures).toHaveLength(0);
    expect(discord.statuses).toEqual(["capacity_wait", "capacity_wait"]);
    expect(state.value.retryCount).toBe(2);
    expect(state.value.lastCapacityFailureAt).toBe(310_001);
    expect(oci.logCalls).toEqual(["failed-1", "failed-5"]);
    expect(oci.detailCalls).toHaveLength(0);
  });

  it("reports capacity but defers CreateJob until the cooldown expires", async () => {
    const { engine, oci, discord, state } = fixture();
    state.value.lastApplyCreatedAt = 9_000;
    const failed = job("failed-cooldown", "FAILED");
    oci.jobs = [failed];
    oci.logs.set(failed.id, "Out of host capacity");

    const result = await engine.run("alarm");

    expect(result).toMatchObject({
      outcome: "capacity_wait",
      retryAfterMilliseconds: 299_000,
    });
    expect(oci.createCalls).toEqual([]);
    expect(discord.statuses).toEqual(["capacity_wait"]);
  });

  it("notifies once and pauses after a meaningful failure", async () => {
    const { engine, oci, discord, state } = fixture();
    const failed = job("failed-2", "FAILED");
    oci.jobs = [failed];
    oci.details.set(
      failed.id,
      job(failed.id, "FAILED", {
        failureDetails: {
          code: "TERRAFORM_EXECUTION_ERROR",
          message: "Invalid subnet configuration",
        },
      }),
    );

    const first = await engine.run("cron");
    const second = await engine.run("cron");

    expect(first.outcome).toBe("meaningful_error");
    expect(second.outcome).toBe("paused");
    expect(discord.failures).toHaveLength(1);
    expect(state.value.errorFingerprints).toHaveLength(1);
    expect(oci.createCalls).toHaveLength(0);
    expect(oci.detailCalls).toEqual(["failed-2"]);
  });

  it("notifies for a distinct meaningful failure after cooldown", async () => {
    const { engine, oci, discord, setClock } = fixture();
    const firstFailed = job("failed-3", "FAILED");
    oci.jobs = [firstFailed];
    oci.details.set(
      firstFailed.id,
      job(firstFailed.id, "FAILED", {
        failureDetails: { code: "ERROR", message: "Invalid image" },
      }),
    );
    await engine.run("cron");

    setClock(30_000_000);
    const secondFailed = job("failed-4", "FAILED");
    oci.jobs = [secondFailed];
    oci.details.set(
      secondFailed.id,
      job(secondFailed.id, "FAILED", {
        failureDetails: { code: "ERROR", message: "Missing variable" },
      }),
    );
    await engine.run("cron");

    expect(discord.failures).toHaveLength(2);
  });

  it("defers transient OCI errors without Discord spam", async () => {
    const { engine, oci, discord } = fixture();
    oci.listError = new OciApiError(
      "Service unavailable",
      503,
      "TRANSIENT",
      undefined,
      900_000,
    );

    const result = await engine.run("cron");

    expect(result.outcome).toBe("transient_error");
    expect(result.retryAfterMilliseconds).toBe(900_000);
    expect(discord.failures).toHaveLength(0);
    expect(oci.createCalls).toHaveLength(0);
  });

  it("reports only the transient result when a capacity retry cannot start", async () => {
    const { engine, oci, discord } = fixture();
    const failed = job("failed-capacity", "FAILED");
    oci.jobs = [failed];
    oci.details.set(
      failed.id,
      job(failed.id, "FAILED", {
        failureDetails: {
          code: "TERRAFORM_EXECUTION_ERROR",
          message: "Out of host capacity",
        },
      }),
    );
    oci.createError = new OciApiError("Gateway timeout", 504, "TRANSIENT");

    const result = await engine.run("cron");

    expect(result.outcome).toBe("transient_error");
    expect(discord.statuses).toEqual([]);
  });

  it("reuses the OCI retry token after an ambiguous create failure", async () => {
    const { engine, oci } = fixture();
    oci.createError = new OciApiError("Gateway timeout", 504, "TRANSIENT");

    await engine.run("cron");
    await engine.run("cron");

    expect(oci.createCalls).toEqual(["fixed-retry-token", "fixed-retry-token"]);
  });

  it("retries a failed success notification without creating a job", async () => {
    const { engine, oci, discord, state } = fixture();
    oci.jobs = [job("success-2", "SUCCEEDED")];
    discord.failSuccess = true;

    await engine.run("cron");
    discord.failSuccess = false;
    const result = await engine.run("cron");

    expect(result.outcome).toBe("terminal_success");
    expect(discord.successes).toBe(2);
    expect(state.value.successNotified).toBe(true);
    expect(oci.createCalls).toHaveLength(0);
  });

  it("retries after a canceled job", async () => {
    const { engine, oci } = fixture();
    oci.jobs = [job("canceled-1", "CANCELED")];

    const result = await engine.run("cron");

    expect(result.outcome).toBe("apply_created");
    expect(oci.createCalls).toHaveLength(1);
  });
});

describe("RunGate", () => {
  it("coalesces two overlapping runs into one task", async () => {
    const gate = new RunGate();
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const task = async () => {
      calls += 1;
      await blocker;
      return { outcome: "job_active", message: "done" } as const;
    };

    const first = gate.run(task);
    const second = gate.run(task);
    release?.();

    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
  });
});
