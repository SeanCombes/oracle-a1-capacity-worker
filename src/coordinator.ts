import { DurableObject } from "cloudflare:workers";
import { DiscordNotifier, type CheckerMetrics } from "./discord";
import { defaultState, DeploymentEngine, RunGate } from "./engine";
import { OciResourceManagerClient } from "./oci-client";
import { safeLog } from "./safe-log";
import type { AutomationState, RunResult, RunTrigger, StatePort } from "./types";

export interface CoordinatorStatus {
  terminalSuccess: boolean;
  successNotified: boolean;
  retryCount: number;
  lastLifecycleState?: string;
  lastCapacityFailureAt?: number;
  lastApplyCreatedAt?: number;
  pausedUntil?: number;
  leaseActive: boolean;
  nextCheckAt?: number;
  updatedAt: number;
}

interface AlarmSchedule {
  jobPollMilliseconds: number;
  transientRetryMilliseconds: number;
}

export function nextAlarmDelayMilliseconds(
  result: RunResult,
  schedule: AlarmSchedule,
): number | null {
  if (result.outcome === "transient_error") {
    return Math.max(
      schedule.transientRetryMilliseconds,
      result.retryAfterMilliseconds ?? 0,
    );
  }
  if (result.retryAfterMilliseconds !== undefined) {
    return Math.max(1_000, result.retryAfterMilliseconds);
  }
  if (result.outcome === "lease_active") return 60_000;
  if (
    result.outcome === "apply_created" ||
    result.outcome === "capacity_wait" ||
    result.outcome === "job_active"
  ) {
    return schedule.jobPollMilliseconds;
  }
  return null;
}

function positiveSeconds(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed * 1000;
}

class SqlStatePort implements StatePort {
  constructor(private readonly ctx: DurableObjectState) {}

  async load(): Promise<AutomationState> {
    const row = this.ctx.storage.sql
      .exec<{ json: string }>("SELECT json FROM automation_state WHERE id = 1")
      .toArray()[0];
    if (!row) {
      const state = defaultState(Date.now());
      await this.save(state);
      return state;
    }
    try {
      return JSON.parse(row.json) as AutomationState;
    } catch {
      safeLog("error", "state_parse_failed");
      return defaultState(Date.now());
    }
  }

  async save(state: AutomationState): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO automation_state (id, json)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      JSON.stringify(state),
    );
  }
}

export class DeploymentCoordinator extends DurableObject<Env> {
  private readonly gate = new RunGate();
  private readonly statePort: StatePort;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.statePort = new SqlStatePort(ctx);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS automation_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS notification_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          discord_status_message_id TEXT
        )`,
      );
    });
  }

  run(trigger: RunTrigger): Promise<RunResult> {
    return this.gate.run(async () => {
      const result = await this.createEngine().run(trigger);
      await this.scheduleNextRun(result);
      return result;
    });
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    safeLog("info", "alarm_discarded_automation_disabled");
  }

  async disableAutomation(): Promise<CoordinatorStatus> {
    await this.ctx.storage.deleteAlarm();
    safeLog("warn", "claim_automation_disabled");
    return this.status();
  }

  async status(): Promise<CoordinatorStatus> {
    const state = await this.statePort.load();
    const nextCheckAt = await this.ctx.storage.getAlarm();
    const now = Date.now();
    return {
      terminalSuccess: state.terminalSuccess,
      successNotified: state.successNotified,
      retryCount: state.retryCount,
      ...(state.lastLifecycleState
        ? { lastLifecycleState: state.lastLifecycleState }
        : {}),
      ...(state.lastCapacityFailureAt
        ? { lastCapacityFailureAt: state.lastCapacityFailureAt }
        : {}),
      ...(state.lastApplyCreatedAt
        ? { lastApplyCreatedAt: state.lastApplyCreatedAt }
        : {}),
      ...(state.pauseUntil ? { pausedUntil: state.pauseUntil } : {}),
      leaseActive: Boolean(state.leaseUntil && state.leaseUntil > now),
      ...(nextCheckAt ? { nextCheckAt } : {}),
      updatedAt: state.updatedAt,
    };
  }

  async reset(): Promise<CoordinatorStatus> {
    await this.ctx.storage.deleteAlarm();
    await this.statePort.save(defaultState(Date.now()));
    safeLog("warn", "coordinator_reset");
    return this.status();
  }

  async sendCheckerEvent(
    event: "heartbeat" | "status" | "failure" | "success",
    summary: string,
    metrics?: CheckerMetrics,
  ): Promise<{ statusMessageId?: string }> {
    const row = this.ctx.storage.sql
      .exec<{ discord_status_message_id: string | null }>(
        "SELECT discord_status_message_id FROM notification_state WHERE id = 1",
      )
      .toArray()[0];
    const notifier = new DiscordNotifier(
      this.env.DISCORD_WEBHOOK_URL,
      this.env.STACK_LABEL,
      this.env.OCI_REGION,
      this.env.DISCORD_SUCCESS_USER_ID,
    );
    const statusMessageId = await notifier.sendCheckerEvent(
      event,
      summary,
      metrics,
      row?.discord_status_message_id ?? undefined,
    );
    if (statusMessageId) {
      this.ctx.storage.sql.exec(
        `INSERT INTO notification_state (id, discord_status_message_id)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET discord_status_message_id = excluded.discord_status_message_id`,
        statusMessageId,
      );
    }
    return statusMessageId ? { statusMessageId } : {};
  }

  private async scheduleNextRun(result: RunResult): Promise<void> {
    let delay = nextAlarmDelayMilliseconds(result, {
      jobPollMilliseconds: positiveSeconds(
        this.env.JOB_POLL_SECONDS,
        "JOB_POLL_SECONDS",
      ),
      transientRetryMilliseconds: positiveSeconds(
        this.env.TRANSIENT_RETRY_SECONDS,
        "TRANSIENT_RETRY_SECONDS",
      ),
    });

    if (result.outcome === "terminal_success") {
      const state = await this.statePort.load();
      if (!state.successNotified) {
        delay = positiveSeconds(this.env.JOB_POLL_SECONDS, "JOB_POLL_SECONDS");
      }
    }

    if (delay === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const scheduledAt = Date.now() + delay;
    await this.ctx.storage.setAlarm(scheduledAt);
    safeLog("info", "alarm_scheduled", {
      outcome: result.outcome,
      delayMilliseconds: delay,
      scheduledAt,
    });
  }

  private createEngine(): DeploymentEngine {
    const oci = new OciResourceManagerClient({
      region: this.env.OCI_REGION,
      stackId: this.env.OCI_STACK_OCID,
      stackLabel: this.env.STACK_LABEL,
      credentials: {
        tenancyId: this.env.OCI_TENANCY_OCID,
        userId: this.env.OCI_USER_OCID,
        fingerprint: this.env.OCI_KEY_FINGERPRINT,
        privateKeyPem: this.env.OCI_PRIVATE_KEY,
      },
    });
    const discord = new DiscordNotifier(
      this.env.DISCORD_WEBHOOK_URL,
      this.env.STACK_LABEL,
      this.env.OCI_REGION,
      this.env.DISCORD_SUCCESS_USER_ID,
    );
    return new DeploymentEngine(this.statePort, oci, discord, {
      leaseMilliseconds: positiveSeconds(this.env.LEASE_SECONDS, "LEASE_SECONDS"),
      errorCooldownMilliseconds: positiveSeconds(
        this.env.ERROR_COOLDOWN_SECONDS,
        "ERROR_COOLDOWN_SECONDS",
      ),
      createCooldownMilliseconds: positiveSeconds(
        this.env.CREATE_COOLDOWN_SECONDS,
        "CREATE_COOLDOWN_SECONDS",
      ),
    });
  }
}
