import { describe, expect, it } from "vitest";
import { DiscordNotifier } from "../src/discord";
import { OciApiError, OciResourceManagerClient } from "../src/oci-client";
import type { OciSigningCredentials } from "../src/oci-signing";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function credentials(): Promise<OciSigningCredentials> {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (generated instanceof CryptoKey) throw new Error("Expected RSA key pair");
  const exported = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("Expected PKCS#8 data");
  return {
    tenancyId: "ocid1.tenancy.oc1..test",
    userId: "ocid1.user.oc1..test",
    fingerprint: "00:11:22:33",
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${toBase64(new Uint8Array(exported))}\n-----END PRIVATE KEY-----`,
  };
}

describe("OCI Resource Manager client", () => {
  it("lists the configured stack's jobs with signed, ordered query parameters", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "ocid1.ormstack.oc1.eu-stockholm-1.test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async (input, init) => {
        capturedUrl = input.toString();
        capturedHeaders = new Headers(init?.headers);
        return Response.json([
          {
            id: "job-1",
            stackId: "stack-1",
            operation: "APPLY",
            lifecycleState: "IN_PROGRESS",
          },
        ]);
      },
    });

    const jobs = await client.listJobs();

    expect(jobs).toHaveLength(1);
    expect(capturedUrl).toContain(
      "/20180917/jobs?stackId=ocid1.ormstack.oc1.eu-stockholm-1.test&sortBy=TIMECREATED&sortOrder=DESC&limit=20",
    );
    expect(capturedHeaders?.get("authorization")).toContain(
      'headers="(request-target) host date"',
    );
  });

  it("creates an auto-approved Apply job with an OCI retry token", async () => {
    let capturedBody = "";
    let capturedHeaders = new Headers();
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "stack-test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async (_input, init) => {
        capturedBody = typeof init?.body === "string" ? init.body : "";
        capturedHeaders = new Headers(init?.headers);
        return Response.json({
          id: "job-created",
          operation: "APPLY",
          lifecycleState: "ACCEPTED",
        });
      },
    });

    const result = await client.createApplyJob("stable-retry-token");
    const payload = JSON.parse(capturedBody) as {
      operation: string;
      jobOperationDetails: {
        operation: string;
        executionPlanStrategy: string;
      };
    };

    expect(result.id).toBe("job-created");
    expect(payload).toMatchObject({
      operation: "APPLY",
      jobOperationDetails: {
        operation: "APPLY",
        executionPlanStrategy: "AUTO_APPROVED",
      },
    });
    expect(capturedHeaders.get("opc-retry-token")).toBe("stable-retry-token");
    expect(capturedHeaders.get("authorization")).toContain(
      "x-content-sha256 content-type content-length",
    );
  });

  it("defers a throttled Apply without repeating CreateJob", async () => {
    let attempts = 0;
    let now = 0;
    const retryTokens: string[] = [];
    const delays: number[] = [];
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "stack-test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async (_input, init) => {
        attempts += 1;
        retryTokens.push(new Headers(init?.headers).get("opc-retry-token") ?? "");
        return Response.json(
          { code: "TooManyRequests", message: "Slow down" },
          { status: 429, headers: { "retry-after": "900" } },
        );
      },
      sleeper: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      clock: () => now,
      random: () => 0,
    });

    const error = await client
      .createApplyJob("stable-retry-token")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 429,
      kind: "TRANSIENT",
      retryAfterMilliseconds: 900_000,
    });
    expect(attempts).toBe(1);
    expect(retryTokens).toEqual(["stable-retry-token"]);
    expect(delays).toEqual([]);
  });

  it("keeps the OCI standard eight-attempt throttling budget for reads", async () => {
    let attempts = 0;
    let now = 0;
    const delays: number[] = [];
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "stack-test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async () => {
        attempts += 1;
        return Response.json(
          { code: "TooManyRequests", message: "Slow down" },
          { status: 429 },
        );
      },
      sleeper: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      clock: () => now,
      random: () => 0,
    });

    const error = await client.listJobs().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OciApiError);
    expect(error).toMatchObject({
      status: 429,
      kind: "TRANSIENT",
      code: "TooManyRequests",
    });
    expect(attempts).toBe(8);
    expect(delays).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
    ]);
  });

  it("paces consecutive OCI requests at least one second apart", async () => {
    let now = 0;
    const delays: number[] = [];
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "stack-test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async (_input, init) =>
        init?.method === "POST"
          ? Response.json({
              id: "job-created",
              operation: "APPLY",
              lifecycleState: "ACCEPTED",
            })
          : Response.json([]),
      sleeper: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      clock: () => now,
      random: () => 0,
    });

    await client.listJobs();
    await client.createApplyJob("stable-retry-token");

    expect(delays).toEqual([1_000]);
  });

  it("classifies OCI permission failures without returning the response body", async () => {
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "stack-test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async () =>
        Response.json(
          { code: "NotAuthorizedOrNotFound", message: "Policy does not allow this operation" },
          { status: 403 },
        ),
    });

    const error = await client.listJobs().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OciApiError);
    expect(error).toMatchObject({ status: 403, kind: "PERMISSION" });
  });

  it("rejects malformed OCI job responses", async () => {
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "stack-test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async () => Response.json([{ lifecycleState: "IN_PROGRESS" }]),
    });

    const error = await client.listJobs().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OciApiError);
    expect(error).toMatchObject({ status: 502, kind: "UNEXPECTED" });
  });

  it("reads the newest structured Terraform log entries first", async () => {
    let capturedUrl = "";
    const client = new OciResourceManagerClient({
      region: "eu-stockholm-1",
      stackId: "stack-test",
      stackLabel: "minecraft-server",
      credentials: await credentials(),
      fetcher: async (input) => {
        capturedUrl = input.toString();
        return Response.json([
          { message: "Out of host capacity for shape VM.Standard.A1.Flex" },
          { message: "Earlier Terraform output" },
        ]);
      },
    });

    const excerpt = await client.getJobLogsExcerpt("job-test");

    expect(capturedUrl).toContain(
      "/jobs/job-test/logs?sortOrder=DESC&limit=100",
    );
    expect(excerpt).toContain("Out of host capacity");
  });

  it("rejects a malformed region before making a request", async () => {
    expect(
      () =>
        new OciResourceManagerClient({
          region: "example.com/steal",
          stackId: "stack-test",
          stackLabel: "minecraft-server",
          credentials: {
            tenancyId: "test",
            userId: "test",
            fingerprint: "test",
            privateKeyPem: "test",
          },
        }),
    ).toThrow(/region/);
  });
});

describe("Discord notifier", () => {
  it("sends a safe success embed to Discord", async () => {
    let payload = "";
    const notifier = new DiscordNotifier(
      "https://discord.com/api/webhooks/test/token",
      "minecraft-server",
      "eu-stockholm-1",
      "100000000000000000",
      async (_input, init) => {
        payload = typeof init?.body === "string" ? init.body : "";
        return new Response(null, { status: 204 });
      },
    );

    await notifier.sendSuccess({
      id: "ocid1.ormjob.oc1.eu-stockholm-1.secret",
      operation: "APPLY",
      lifecycleState: "SUCCEEDED",
    });

    expect(payload).toContain("OCI A1 deployment succeeded");
    expect(payload).not.toContain("ocid1.ormjob");
    expect(payload).toContain('"parse":[]');
    expect(payload).toContain('"content":"<@100000000000000000>"');
    expect(payload).toContain('"users":["100000000000000000"]');
  });

  it("redacts identifiers and URLs in failure embeds", async () => {
    let payload = "";
    const notifier = new DiscordNotifier(
      "https://discord.com/api/webhooks/test/token",
      "minecraft-server",
      "eu-stockholm-1",
      "100000000000000000",
      async (_input, init) => {
        payload = typeof init?.body === "string" ? init.body : "";
        return new Response(null, { status: 204 });
      },
    );

    await notifier.sendFailure(
      "Failure for ocid1.instance.oc1.eu-stockholm-1.secret at https://secret.example/path",
      "abcdef1234567890",
    );

    expect(payload).not.toContain("secret.example");
    expect(payload).not.toContain("ocid1.instance");
    expect(payload).toContain("abcdef123456");
    expect(payload).not.toContain("<@100000000000000000>");
  });

  it("sends a compact capacity failure embed without mentions", async () => {
    let payload = "";
    const notifier = new DiscordNotifier(
      "https://discord.com/api/webhooks/test/token",
      "minecraft-server",
      "eu-stockholm-1",
      "100000000000000000",
      async (_input, init) => {
        payload = typeof init?.body === "string" ? init.body : "";
        return new Response(null, { status: 204 });
      },
    );

    await notifier.sendRunStatus({
      outcome: "capacity_wait",
      message: "capacity unavailable",
    });

    expect(payload).toContain('"username":"Oracle"');
    expect(payload).toContain("A1 capacity unavailable");
    expect(payload).toContain("The Worker will retry automatically.");
    expect(payload).toContain('"parse":[]');
    expect(payload).not.toContain("<@");
    expect(payload).toContain('"embeds"');
  });

  it("keeps routine and transient outcomes quiet", async () => {
    let calls = 0;
    const notifier = new DiscordNotifier(
      "https://discord.com/api/webhooks/test/token",
      "minecraft-server",
      "eu-stockholm-1",
      "100000000000000000",
      async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
    );

    await notifier.sendRunStatus({
      outcome: "job_active",
      jobState: "ACCEPTED",
      message: "active",
    });
    await notifier.sendRunStatus({
      outcome: "transient_error",
      message: "throttled",
    });
    await notifier.sendRunStatus({
      outcome: "apply_created",
      message: "created",
    });

    expect(calls).toBe(0);
  });

  it("creates one checker status message, edits it, and keeps success as a separate ping", async () => {
    const payloads: string[] = [];
    const requests: Array<{ method: string; url: string }> = [];
    const notifier = new DiscordNotifier(
      "https://discord.com/api/webhooks/test/token",
      "minecraft-server",
      "eu-stockholm-1",
      "100000000000000000",
      async (input, init) => {
        payloads.push(typeof init?.body === "string" ? init.body : "");
        requests.push({ method: init?.method ?? "GET", url: String(input) });
        if (init?.method === "POST" && String(input).includes("wait=true")) {
          return Response.json({ id: "123456789012345678" });
        }
        return new Response(null, { status: init?.method === "PATCH" ? 200 : 204 });
      },
    );

    const metrics = {
      checksRun: 1234,
      ramPercent: 69.3,
      cpuPercent: 18,
      pollIntervalSeconds: 30,
    };
    const messageId = await notifier.sendCheckerEvent("heartbeat", "Still checking", metrics);
    await notifier.sendCheckerEvent("heartbeat", "Still checking", metrics, messageId);
    await notifier.sendCheckerEvent("success", "A1 is running", metrics);

    expect(payloads[0]).toContain("Oracle A1 Capacity Watcher");
    expect(payloads[0]).toContain("1,234");
    expect(payloads[0]).toContain("69.3%");
    expect(payloads[0]).toContain("18.0%");
    expect(payloads[0]).toContain("Live status every 30 seconds");
    expect(payloads[0]).not.toContain("<@");
    expect(messageId).toBe("123456789012345678");
    expect(requests[0]).toEqual({ method: "POST", url: "https://discord.com/api/webhooks/test/token?wait=true" });
    expect(requests[1]).toEqual({ method: "PATCH", url: "https://discord.com/api/webhooks/test/token/messages/123456789012345678" });
    expect(payloads[2]).toContain("OCI A1 instance claimed");
    expect(payloads[2]).toContain("Automatic claim attempts have stopped");
    expect(payloads[2]).toContain('"content":"<@100000000000000000>"');
  });

  it("recreates the checker status message if the saved Discord message was deleted", async () => {
    const methods: string[] = [];
    const notifier = new DiscordNotifier(
      "https://discord.com/api/webhooks/test/token",
      "minecraft-server",
      "eu-stockholm-1",
      "100000000000000000",
      async (_input, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "PATCH") return new Response("unknown message", { status: 404 });
        return Response.json({ id: "223456789012345678" });
      },
    );
    const id = await notifier.sendCheckerEvent("heartbeat", "Still checking", {
      checksRun: 10,
      ramPercent: 20,
      cpuPercent: 5,
      pollIntervalSeconds: 30,
    }, "123456789012345678");
    expect(methods).toEqual(["PATCH", "POST"]);
    expect(id).toBe("223456789012345678");
  });

  it("rejects non-Discord webhook hosts", () => {
    expect(
      () =>
        new DiscordNotifier(
          "https://evil.example/webhook",
          "minecraft-server",
          "eu-stockholm-1",
          "100000000000000000",
        ),
    ).toThrow(/Discord/);
  });

  it("surfaces a bounded Discord API failure", async () => {
    const notifier = new DiscordNotifier(
      "https://discord.com/api/webhooks/test/token",
      "minecraft-server",
      "eu-stockholm-1",
      "100000000000000000",
      async () => new Response("invalid webhook", { status: 404 }),
    );

    const error = await notifier
      .sendFailure("Configuration failed", "abcdef1234567890")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 404");
  });
});
