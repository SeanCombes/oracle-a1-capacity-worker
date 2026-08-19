import { redactIdentifier, safeLog } from "./safe-log";
import { signOciRequest, type OciSigningCredentials } from "./oci-signing";
import type { JobLifecycleState, OciClientPort, OciJob } from "./types";

const JOB_STATES = new Set<JobLifecycleState>([
  "ACCEPTED",
  "IN_PROGRESS",
  "FAILED",
  "SUCCEEDED",
  "CANCELING",
  "CANCELED",
]);

export type OciErrorKind =
  | "AUTHENTICATION"
  | "PERMISSION"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TRANSIENT"
  | "UNEXPECTED";

export class OciApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: OciErrorKind,
    readonly code?: string,
    readonly retryAfterMilliseconds?: number,
  ) {
    super(message);
    this.name = "OciApiError";
  }
}

export interface OciClientConfig {
  region: string;
  stackId: string;
  stackLabel: string;
  credentials: OciSigningCredentials;
  fetcher?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  sleeper?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  random?: () => number;
  minimumRequestIntervalMilliseconds?: number;
}

const MAXIMUM_ATTEMPTS = 8;
const BASE_RETRY_DELAY_MILLISECONDS = 1_000;
const MAX_RETRY_DELAY_MILLISECONDS = 30_000;
const DEFAULT_REQUEST_INTERVAL_MILLISECONDS = 1_000;

interface RawJob {
  id?: unknown;
  stackId?: unknown;
  operation?: unknown;
  lifecycleState?: unknown;
  displayName?: unknown;
  timeCreated?: unknown;
  timeFinished?: unknown;
  failureDetails?: {
    code?: unknown;
    message?: unknown;
  };
}

interface RawLogEntry {
  message?: unknown;
}

function assertRegion(region: string): void {
  if (!/^[a-z]{2}-[a-z0-9-]+-\d+$/.test(region)) {
    throw new Error("OCI_REGION is not a valid commercial OCI region identifier");
  }
}

function parseJob(value: unknown): OciJob {
  if (!value || typeof value !== "object") {
    throw new OciApiError("OCI returned a malformed job object", 502, "UNEXPECTED");
  }

  const raw = value as RawJob;
  if (
    typeof raw.id !== "string" ||
    typeof raw.operation !== "string" ||
    typeof raw.lifecycleState !== "string" ||
    !JOB_STATES.has(raw.lifecycleState as JobLifecycleState)
  ) {
    throw new OciApiError("OCI returned incomplete job fields", 502, "UNEXPECTED");
  }

  const job: OciJob = {
    id: raw.id,
    operation: raw.operation,
    lifecycleState: raw.lifecycleState as JobLifecycleState,
  };
  if (typeof raw.stackId === "string") job.stackId = raw.stackId;
  if (typeof raw.displayName === "string") job.displayName = raw.displayName;
  if (typeof raw.timeCreated === "string") job.timeCreated = raw.timeCreated;
  if (typeof raw.timeFinished === "string") job.timeFinished = raw.timeFinished;
  if (
    raw.failureDetails &&
    typeof raw.failureDetails.code === "string" &&
    typeof raw.failureDetails.message === "string"
  ) {
    job.failureDetails = {
      code: raw.failureDetails.code,
      message: raw.failureDetails.message,
    };
  }
  return job;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";

  try {
    while (total < limit) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = limit - total;
      const chunk = part.value.subarray(0, remaining);
      result += decoder.decode(chunk, { stream: true });
      total += chunk.byteLength;
      if (chunk.byteLength < part.value.byteLength) break;
    }
    result += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return result;
}

function errorKindForStatus(status: number): OciErrorKind {
  if (status === 401) return "AUTHENTICATION";
  if (status === 403) return "PERMISSION";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  if (status === 408 || status === 429 || status >= 500) return "TRANSIENT";
  return "UNEXPECTED";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(response: Response, now: number): number {
  const value = response.headers.get("retry-after");
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function retryDelayMilliseconds(
  response: Response | undefined,
  attempt: number,
  now: number,
  random: () => number,
): number {
  const exponentialDelay = Math.min(
    BASE_RETRY_DELAY_MILLISECONDS * 2 ** (attempt - 1),
    MAX_RETRY_DELAY_MILLISECONDS,
  );
  const jitter = Math.floor(random() * 1_001);
  const requestedDelay = response ? retryAfterMilliseconds(response, now) : 0;
  return Math.min(
    Math.max(exponentialDelay + jitter, requestedDelay),
    MAX_RETRY_DELAY_MILLISECONDS,
  );
}

function parseErrorPayload(text: string): { code?: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const candidate = parsed as { code?: unknown; message?: unknown };
      return {
        ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
        message:
          typeof candidate.message === "string"
            ? candidate.message.slice(0, 500)
            : "OCI request failed",
      };
    }
  } catch {
    // Fall through to a safe generic message.
  }
  return { message: "OCI request failed" };
}

export class OciResourceManagerClient implements OciClientPort {
  private readonly endpoint: string;
  private readonly fetcher: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly sleeper: (milliseconds: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly minimumRequestIntervalMilliseconds: number;
  private nextRequestAt = 0;

  constructor(private readonly config: OciClientConfig) {
    assertRegion(config.region);
    this.endpoint = `https://resourcemanager.${config.region}.oraclecloud.com/20180917`;
    this.fetcher = config.fetcher ?? ((input, init) => fetch(input, init));
    this.sleeper =
      config.sleeper ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.clock = config.clock ?? (() => Date.now());
    this.random = config.random ?? (() => Math.random());
    this.minimumRequestIntervalMilliseconds =
      config.minimumRequestIntervalMilliseconds ??
      DEFAULT_REQUEST_INTERVAL_MILLISECONDS;
    if (
      !Number.isFinite(this.minimumRequestIntervalMilliseconds) ||
      this.minimumRequestIntervalMilliseconds < 0
    ) {
      throw new Error("minimumRequestIntervalMilliseconds must be non-negative");
    }
  }

  async listJobs(): Promise<OciJob[]> {
    const url = new URL(`${this.endpoint}/jobs`);
    url.searchParams.set("stackId", this.config.stackId);
    url.searchParams.set("sortBy", "TIMECREATED");
    url.searchParams.set("sortOrder", "DESC");
    url.searchParams.set("limit", "20");
    const value = await this.requestJson("GET", url);
    if (!Array.isArray(value)) {
      throw new OciApiError("OCI returned a malformed jobs list", 502, "UNEXPECTED");
    }
    return value.map(parseJob);
  }

  async getJob(jobId: string): Promise<OciJob> {
    const url = new URL(`${this.endpoint}/jobs/${encodeURIComponent(jobId)}`);
    return parseJob(await this.requestJson("GET", url));
  }

  async getJobLogsExcerpt(jobId: string): Promise<string> {
    const url = new URL(`${this.endpoint}/jobs/${encodeURIComponent(jobId)}/logs`);
    url.searchParams.set("sortOrder", "DESC");
    url.searchParams.set("limit", "100");
    const value = await this.requestJson("GET", url);
    if (!Array.isArray(value)) {
      throw new OciApiError("OCI returned a malformed job log list", 502, "UNEXPECTED");
    }
    return value
      .map((entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as RawLogEntry).message === "string"
          ? (entry as RawLogEntry).message
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .slice(0, 64 * 1024);
  }

  async createApplyJob(retryToken: string): Promise<OciJob> {
    const url = new URL(`${this.endpoint}/jobs`);
    const body = JSON.stringify({
      stackId: this.config.stackId,
      displayName: `${this.config.stackLabel}-capacity-retry`,
      operation: "APPLY",
      jobOperationDetails: {
        operation: "APPLY",
        executionPlanStrategy: "AUTO_APPROVED",
      },
    });
    const value = await this.requestJson(
      "POST",
      url,
      body,
      { "opc-retry-token": retryToken },
      false,
    );
    return parseJob(value);
  }

  private async requestJson(
    method: "GET" | "POST",
    url: URL,
    body?: string,
    extraHeaders?: Record<string, string>,
    retryThrottled = true,
  ): Promise<unknown> {
    const response = await this.request(
      method,
      url,
      body,
      extraHeaders,
      retryThrottled,
    );
    const text = await readBoundedText(response, 1024 * 1024);
    try {
      return JSON.parse(text);
    } catch {
      throw new OciApiError("OCI returned invalid JSON", 502, "UNEXPECTED");
    }
  }

  private async request(
    method: "GET" | "POST",
    url: URL,
    body?: string,
    extraHeaders?: Record<string, string>,
    retryThrottled = true,
  ): Promise<Response> {
    for (let attempt = 1; attempt <= MAXIMUM_ATTEMPTS; attempt += 1) {
      await this.waitForRequestSlot();
      const headers = await signOciRequest(
        {
          method,
          url,
          ...(body === undefined ? {} : { body }),
          ...(extraHeaders === undefined ? {} : { extraHeaders }),
        },
        this.config.credentials,
      );

      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
        });
      } catch {
        if (attempt === MAXIMUM_ATTEMPTS) {
          throw new OciApiError("OCI network request failed", 0, "TRANSIENT");
        }
        const delayMilliseconds = retryDelayMilliseconds(
          undefined,
          attempt,
          this.clock(),
          this.random,
        );
        safeLog("warn", "oci_retry_scheduled", {
          method,
          status: 0,
          attempt,
          delayMilliseconds,
          stack: redactIdentifier(this.config.stackId),
        });
        await this.sleeper(delayMilliseconds);
        continue;
      }

      safeLog("info", "oci_response", {
        method,
        status: response.status,
        attempt,
        stack: redactIdentifier(this.config.stackId),
      });

      if (response.ok) return response;

      const retryable =
        isRetryableStatus(response.status) &&
        (response.status !== 429 || retryThrottled);
      if (retryable && attempt < MAXIMUM_ATTEMPTS) {
        const delayMilliseconds = retryDelayMilliseconds(
          response,
          attempt,
          this.clock(),
          this.random,
        );
        await response.body?.cancel().catch(() => undefined);
        safeLog("warn", "oci_retry_scheduled", {
          method,
          status: response.status,
          attempt,
          delayMilliseconds,
          stack: redactIdentifier(this.config.stackId),
        });
        await this.sleeper(delayMilliseconds);
        continue;
      }

      const requestedRetryDelay = retryAfterMilliseconds(response, this.clock());
      const payload = parseErrorPayload(await readBoundedText(response, 32 * 1024));
      throw new OciApiError(
        payload.message,
        response.status,
        errorKindForStatus(response.status),
        payload.code,
        requestedRetryDelay > 0 ? requestedRetryDelay : undefined,
      );
    }

    throw new OciApiError("OCI request retry limit reached", 0, "TRANSIENT");
  }

  private async waitForRequestSlot(): Promise<void> {
    const delayMilliseconds = Math.max(0, this.nextRequestAt - this.clock());
    if (delayMilliseconds > 0) await this.sleeper(delayMilliseconds);
    this.nextRequestAt = this.clock() + this.minimumRequestIntervalMilliseconds;
  }
}
