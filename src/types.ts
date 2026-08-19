export type JobLifecycleState =
  | "ACCEPTED"
  | "IN_PROGRESS"
  | "FAILED"
  | "SUCCEEDED"
  | "CANCELING"
  | "CANCELED";

export interface OciJob {
  id: string;
  stackId?: string;
  operation: string;
  lifecycleState: JobLifecycleState;
  displayName?: string;
  timeCreated?: string;
  timeFinished?: string;
  failureDetails?: {
    code: string;
    message: string;
  };
}

export interface AutomationState {
  terminalSuccess: boolean;
  successNotified: boolean;
  activeJobId?: string;
  lastLifecycleState?: JobLifecycleState;
  retryCount: number;
  lastCapacityFailureAt?: number;
  lastProcessedFailedJobId?: string;
  errorFingerprints: string[];
  pauseUntil?: number;
  leaseUntil?: number;
  pendingRetryToken?: string;
  pendingRetryTokenCreatedAt?: number;
  lastApplyCreatedAt?: number;
  updatedAt: number;
}

export interface RunResult {
  outcome:
    | "apply_created"
    | "job_active"
    | "capacity_wait"
    | "create_deferred"
    | "terminal_success"
    | "paused"
    | "transient_error"
    | "meaningful_error"
    | "lease_active";
  jobState?: JobLifecycleState;
  retryAfterMilliseconds?: number;
  message: string;
}

export type RunTrigger = "cron" | "manual" | "alarm";

export interface OciClientPort {
  listJobs(): Promise<OciJob[]>;
  getJob(jobId: string): Promise<OciJob>;
  getJobLogsExcerpt(jobId: string): Promise<string>;
  createApplyJob(retryToken: string): Promise<OciJob>;
}

export interface DiscordPort {
  sendSuccess(job: OciJob): Promise<void>;
  sendFailure(summary: string, fingerprint: string): Promise<void>;
  sendRunStatus(result: RunResult): Promise<void>;
}

export interface StatePort {
  load(): Promise<AutomationState>;
  save(state: AutomationState): Promise<void>;
}
