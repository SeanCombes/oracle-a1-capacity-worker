import { safeLog } from "./safe-log";
import type { CheckerMetrics } from "./discord";

export { DeploymentCoordinator } from "./coordinator";

const encoder = new TextEncoder();

async function authorized(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function coordinator(env: Env) {
  return env.DEPLOYMENT_COORDINATOR.getByName("primary");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await coordinator(env).disableAutomation();
    safeLog("info", "cron_ignored_automation_disabled", { cron: controller.cron });
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(await coordinator(env).status());
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/run" ||
        url.pathname === "/reset" ||
        url.pathname === "/notify" ||
        url.pathname === "/disable-automation")
    ) {
      const notifierPath = url.pathname === "/notify" || url.pathname === "/disable-automation";
      const expectedToken = notifierPath ? env.NOTIFY_TOKEN : env.ADMIN_TOKEN;
      if (!(await authorized(request, expectedToken))) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (url.pathname === "/disable-automation") {
        return json(await coordinator(env).disableAutomation());
      }
      if (url.pathname === "/notify") {
        await coordinator(env).disableAutomation();
        let body: { event?: unknown; content?: unknown; metrics?: unknown };
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        const events = ["heartbeat", "status", "failure", "success"] as const;
        if (
          typeof body.content !== "string" ||
          body.content.length < 1 ||
          body.content.length > 1000 ||
          !events.includes(body.event as (typeof events)[number])
        ) {
          return json({ error: "Invalid notification" }, 400);
        }
        let metrics: CheckerMetrics | undefined;
        if (body.metrics !== undefined) {
          const candidate = body.metrics as Partial<CheckerMetrics>;
          if (
            typeof candidate !== "object" ||
            candidate === null ||
            !Number.isSafeInteger(candidate.checksRun) ||
            (candidate.checksRun ?? -1) < 0 ||
            typeof candidate.ramPercent !== "number" ||
            !Number.isFinite(candidate.ramPercent) ||
            candidate.ramPercent < 0 ||
            candidate.ramPercent > 100 ||
            typeof candidate.cpuPercent !== "number" ||
            !Number.isFinite(candidate.cpuPercent) ||
            candidate.cpuPercent < 0 ||
            candidate.cpuPercent > 100 ||
            !Number.isSafeInteger(candidate.pollIntervalSeconds) ||
            (candidate.pollIntervalSeconds ?? 0) < 30
          ) {
            return json({ error: "Invalid metrics" }, 400);
          }
          metrics = candidate as CheckerMetrics;
        }
        const result = await coordinator(env).sendCheckerEvent(
          body.event as (typeof events)[number],
          body.content,
          metrics,
        );
        return json({ ok: true, ...result });
      }
      if (url.pathname === "/reset") {
        return json(await coordinator(env).reset());
      }
      return json({ error: "Cloudflare claim automation is disabled" }, 409);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
