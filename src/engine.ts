import { OciApiError } from "./oci-client";
import { sha256Hex } from "./oci-signing";
import { redactIdentifier, safeLog } from "./safe-log";
import type {
  AutomationState,
  DiscordPort,
  OciClientPort,
  OciJob,
  RunResult,
  RunTrigger,
  StatePort,
} from "./types";

const ACTIVE_STATES = new Set(["ACCEPTED", "IN_PROGRESS", "CANCELING"]);
const CAPACITY_PATTERN = new RegExp(
  atob(
    "b3V0W1xzXy1dKm9mW1xzXy1dKig/Omhvc3RbXHNfLV0qKT9jYXBhY2l0eXxob3N0IGNhcGFjaXR5fG91dG9maG9zdGNhcGFjaXR5fG5vIGF2YWlsYWJsZSBob3N0",
  ),
  "i",
);

export interface EngineOptions {
  leaseMilliseconds: number;
  errorCooldownMilliseconds: number;
  createCooldownMilliseconds: number;
  now?: () => number;
  uuid?: () => string;
}

export function defaultState(now: number): AutomationState {
  return {
    terminalSuccess: false,
    successNotified: false,
    retryCount: 0,
    errorFingerprints: [],
    updatedAt: now,
  };
}

export function sanitizeFailure(value: string): string {
  return value
    .replace(/ocid1\.[a-z0-9._-]+/gi, "[redacted-ocid]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/Signature\s+version=.*$/gi, "[redacted-signature]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export class RunGate {
  private current: Promise<RunResult> | undefined;

  run(task: () => Promise<RunResult>): Promise<RunResult> {
    if (this.current) return this.current;
    this.current = task().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }
}

export class DeploymentEngine {
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(
    private readonly statePort: StatePort,
    private readonly oci: OciClientPort,
    private readonly discord: DiscordPort,
    private readonly options: EngineOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  async run(trigger: RunTrigger): Promise<RunResult> {
    const now = this.now();
    const state = await this.statePort.load();

    if (state.terminalSuccess) {
      return this.finishTerminalNotification(state);
    }
    if (state.pauseUntil && state.pauseUntil > now) {
      return {
        outcome: "paused",
        message: "Automation is paused after a meaningful failure",
      };
    }
    if (state.leaseUntil && state.leaseUntil > now) {
      return {
        outcome: "lease_active",
        message: "Another reconciliation run owns the active lease",
      };
    }

    state.leaseUntil = now + this.options.leaseMilliseconds;
    state.updatedAt = now;
    await this.statePort.save(state);
    safeLog("info", "reconcile_started", { trigger });

    let result: RunResult;
    try {
      result = await this.reconcile(state);
    } catch (error) {
      result = await this.handleRunError(state, error);
    } finally {
      delete state.leaseUntil;
      state.updatedAt = this.now();
      await this.statePort.save(state);
    }
    if (result.outcome === "capacity_wait") {
      await this.notifyRunStatus(result);
    }
    return result;
  }

  private async reconcile(state: AutomationState): Promise<RunResult> {
    let capacityFailureDetected = false;
    const jobs = (await this.oci.listJobs())
      .filter((job) => job.operation === "APPLY")
      .sort((left, right) => (right.timeCreated ?? "").localeCompare(left.timeCreated ?? ""));

    const observedCreatedAt = Date.parse(jobs[0]?.timeCreated ?? "");
    if (Number.isFinite(observedCreatedAt) && observedCreatedAt <= this.now()) {
      state.lastApplyCreatedAt = Math.max(
        state.lastApplyCreatedAt ?? 0,
        observedCreatedAt,
      );
    }

    const succeeded = jobs.find((job) => job.lifecycleState === "SUCCEEDED");
    if (succeeded) return this.markSuccess(state, succeeded);

    const active = jobs.find((job) => ACTIVE_STATES.has(job.lifecycleState));
    if (active) {
      state.activeJobId = active.id;
      state.lastLifecycleState = active.lifecycleState;
      delete state.pendingRetryToken;
      delete state.pendingRetryTokenCreatedAt;
      return {
        outcome: "job_active",
        jobState: active.lifecycleState,
        message: "An Apply job is already active",
      };
    }

    const latest = jobs[0];
    if (latest?.lifecycleState === "FAILED" && latest.id !== state.lastProcessedFailedJobId) {
      const logs = await this.oci.getJobLogsExcerpt(latest.id);
      let rawFailureText = [
        latest.failureDetails?.code,
        latest.failureDetails?.message,
        logs,
      ]
        .filter(Boolean)
        .join(" ");
      let capacityFailure = CAPACITY_PATTERN.test(rawFailureText);
      if (!capacityFailure) {
        const detailed = await this.oci.getJob(latest.id);
        rawFailureText = [
          detailed.failureDetails?.code,
          detailed.failureDetails?.message,
          logs,
        ]
          .filter(Boolean)
          .join(" ");
        capacityFailure = CAPACITY_PATTERN.test(rawFailureText);
      }
      const failureText = sanitizeFailure(rawFailureText);
      state.lastProcessedFailedJobId = latest.id;
      state.lastLifecycleState = "FAILED";
      delete state.activeJobId;

      if (capacityFailure) {
        capacityFailureDetected = true;
        state.retryCount += 1;
        state.lastCapacityFailureAt = this.now();
        safeLog("info", "capacity_unavailable", {
          retries: state.retryCount,
          job: redactIdentifier(latest.id),
        });
      } else {
        return this.recordMeaningfulFailure(
          state,
          failureText || "Resource Manager Apply job failed without usable details",
        );
      }
    }

    const createAllowedAt =
      (state.lastApplyCreatedAt ?? 0) + this.options.createCooldownMilliseconds;
    const retryAfterMilliseconds = Math.max(0, createAllowedAt - this.now());
    if (state.lastApplyCreatedAt && retryAfterMilliseconds > 0) {
      safeLog("info", "apply_create_deferred", {
        retryAfterMilliseconds,
        capacityFailureDetected,
      });
      return {
        outcome: capacityFailureDetected ? "capacity_wait" : "create_deferred",
        retryAfterMilliseconds,
        message: capacityFailureDetected
          ? "No A1 capacity was available; creation is deferred by the OCI cooldown"
          : "Apply creation is deferred by the OCI cooldown",
      };
    }

    const retryToken =
      state.pendingRetryToken &&
      state.pendingRetryTokenCreatedAt &&
      this.now() - state.pendingRetryTokenCreatedAt < 24 * 60 * 60 * 1000
        ? state.pendingRetryToken
        : this.uuid();
    state.pendingRetryToken = retryToken;
    state.pendingRetryTokenCreatedAt = this.now();
    await this.statePort.save(state);

    const created = await this.oci.createApplyJob(retryToken);
    state.lastApplyCreatedAt = this.now();
    state.activeJobId = created.id;
    state.lastLifecycleState = created.lifecycleState;
    delete state.pendingRetryToken;
    delete state.pendingRetryTokenCreatedAt;
    safeLog("info", "apply_created", {
      job: redactIdentifier(created.id),
      state: created.lifecycleState,
    });
    return {
      outcome: capacityFailureDetected ? "capacity_wait" : "apply_created",
      jobState: created.lifecycleState,
      message: capacityFailureDetected
        ? "No A1 capacity was available; a new Apply job was created"
        : "A new auto-approved Apply job was created",
    };
  }

  private async notifyRunStatus(result: RunResult): Promise<void> {
    try {
      await this.discord.sendRunStatus(result);
    } catch (error) {
      safeLog("error", "discord_status_notification_failed", {
        outcome: result.outcome,
        message: sanitizeFailure(error instanceof Error ? error.message : "Unknown error"),
      });
    }
  }

  private async markSuccess(
    state: AutomationState,
    job: OciJob,
  ): Promise<RunResult> {
    state.terminalSuccess = true;
    state.activeJobId = job.id;
    state.lastLifecycleState = "SUCCEEDED";
    delete state.pauseUntil;
    delete state.pendingRetryToken;
    delete state.pendingRetryTokenCreatedAt;
    await this.statePort.save(state);

    try {
      await this.discord.sendSuccess(job);
      state.successNotified = true;
    } catch (error) {
      safeLog("error", "discord_success_notification_failed", {
        message: sanitizeFailure(error instanceof Error ? error.message : "Unknown error"),
      });
    }
    return {
      outcome: "terminal_success",
      jobState: "SUCCEEDED",
      message: state.successNotified
        ? "Deployment succeeded and Discord was notified"
        : "Deployment succeeded; Discord notification will retry",
    };
  }

  private async finishTerminalNotification(
    state: AutomationState,
  ): Promise<RunResult> {
    if (!state.successNotified && state.activeJobId) {
      try {
        const job = await this.oci.getJob(state.activeJobId);
        await this.discord.sendSuccess(job);
        state.successNotified = true;
        state.updatedAt = this.now();
        await this.statePort.save(state);
      } catch (error) {
        safeLog("error", "discord_success_notification_retry_failed", {
          message: sanitizeFailure(error instanceof Error ? error.message : "Unknown error"),
        });
      }
    }
    return {
      outcome: "terminal_success",
      jobState: "SUCCEEDED",
      message: state.successNotified
        ? "Terminal success is persisted; no Apply job was created"
        : "Terminal success is persisted; Discord notification remains pending",
    };
  }

  private async recordMeaningfulFailure(
    state: AutomationState,
    summary: string,
  ): Promise<RunResult> {
    const safeSummary = sanitizeFailure(summary);
    const fingerprint = await sha256Hex(safeSummary.toLowerCase());
    state.pauseUntil = this.now() + this.options.errorCooldownMilliseconds;

    if (!state.errorFingerprints.includes(fingerprint)) {
      try {
        await this.discord.sendFailure(safeSummary, fingerprint);
        state.errorFingerprints = [...state.errorFingerprints, fingerprint].slice(-20);
      } catch (error) {
        safeLog("error", "discord_failure_notification_failed", {
          message: sanitizeFailure(error instanceof Error ? error.message : "Unknown error"),
        });
      }
    }
    safeLog("warn", "meaningful_failure", {
      errorId: fingerprint.slice(0, 12),
    });
    return {
      outcome: "meaningful_error",
      message: safeSummary,
    };
  }

  private async handleRunError(
    state: AutomationState,
    error: unknown,
  ): Promise<RunResult> {
    if (error instanceof OciApiError) {
      if (error.kind === "TRANSIENT" || error.kind === "CONFLICT") {
        safeLog("warn", "oci_transient_error", {
          status: error.status,
          kind: error.kind,
        });
        return {
          outcome: "transient_error",
          ...(error.retryAfterMilliseconds
            ? { retryAfterMilliseconds: error.retryAfterMilliseconds }
            : {}),
          message: `OCI transient error (${error.status}); retry deferred to the next Cron run`,
        };
      }
      return this.recordMeaningfulFailure(
        state,
        `OCI ${error.kind.toLowerCase().replace("_", " ")} error (${error.status}): ${error.message}`,
      );
    }
    return this.recordMeaningfulFailure(
      state,
      error instanceof Error ? error.message : "Unexpected automation error",
    );
  }
}
