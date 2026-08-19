import type { DiscordPort, OciJob, RunResult } from "./types";

function sanitize(value: string): string {
  return value
    .replace(/ocid1\.[a-z0-9._-]+/gi, "[redacted-ocid]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/Signature\s+version=.*$/gi, "[redacted-signature]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function readShortError(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const part = await reader.read();
  await reader.cancel().catch(() => undefined);
  if (part.done) return "";
  return new TextDecoder().decode(part.value.subarray(0, 2048));
}

export interface CheckerMetrics {
  checksRun: number;
  ramPercent: number;
  cpuPercent: number;
  pollIntervalSeconds: number;
}

function usageBar(percent: number): string {
  const value = Math.max(0, Math.min(100, percent));
  const filled = Math.round(value / 10);
  return `\`${"█".repeat(filled)}${"░".repeat(10 - filled)}\` **${value.toFixed(1)}%**`;
}

export class DiscordNotifier implements DiscordPort {
  constructor(
    private readonly webhookUrl: string,
    private readonly stackLabel: string,
    private readonly region: string,
    private readonly successUserId: string,
    private readonly fetcher: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response> = (input, init) => fetch(input, init),
  ) {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname)) {
      throw new Error("DISCORD_WEBHOOK_URL must use an official Discord HTTPS host");
    }
    if (!/^\d{17,20}$/.test(successUserId)) {
      throw new Error("DISCORD_SUCCESS_USER_ID must be a Discord user ID");
    }
  }

  async sendSuccess(job: OciJob): Promise<void> {
    await this.send(
      {
        title: "OCI A1 deployment succeeded",
        description: "The Resource Manager Apply job completed successfully. Automatic deployment retries are now disabled.",
        color: 0x2ecc71,
        fields: [
          { name: "Stack", value: sanitize(this.stackLabel), inline: true },
          { name: "Region", value: sanitize(this.region), inline: true },
          { name: "State", value: job.lifecycleState, inline: true },
        ],
      },
      true,
    );
  }

  async sendFailure(summary: string, fingerprint: string): Promise<void> {
    await this.send({
      title: "OCI A1 deployment needs attention",
      description: sanitize(summary),
      color: 0xe67e22,
      fields: [
        { name: "Stack", value: sanitize(this.stackLabel), inline: true },
        { name: "Region", value: sanitize(this.region), inline: true },
        { name: "Error ID", value: fingerprint.slice(0, 12), inline: true },
      ],
    });
  }

  async sendRunStatus(result: RunResult): Promise<void> {
    const statuses: Partial<
      Record<
        RunResult["outcome"],
        { title: string; description: string; color: number }
      >
    > = {
      capacity_wait: {
        title: "A1 capacity unavailable",
        description: "No capacity was available. The Worker will retry automatically.",
        color: 0xf59e0b,
      },
    };
    const status = statuses[result.outcome];

    if (!status) return;
    await this.post({
      username: "Oracle",
      allowed_mentions: { parse: [] },
      embeds: [{ ...status, timestamp: new Date().toISOString() }],
    });
  }

  async sendCheckerEvent(
    event: "heartbeat" | "status" | "failure" | "success",
    summary: string,
    metrics?: CheckerMetrics,
    statusMessageId?: string,
  ): Promise<string | undefined> {
    if (event === "heartbeat" && metrics) {
      return this.upsertStatus({
        title: "🟣 Oracle A1 Capacity Watcher",
        description: "**Online and checking**\nNo A1 capacity is available yet. Automatic checks continue in the background.",
        color: 0x8b5cf6,
        fields: [
          { name: "🔎 Capacity checks", value: `**${metrics.checksRun.toLocaleString("en-US")}**`, inline: true },
          { name: "⏱️ Check interval", value: `**${metrics.pollIntervalSeconds}s**`, inline: true },
          { name: "📍 Region", value: `\`${sanitize(this.region)}\``, inline: true },
          { name: "🧠 RAM usage", value: usageBar(metrics.ramPercent), inline: false },
          { name: "⚙️ CPU usage", value: usageBar(metrics.cpuPercent), inline: false },
        ],
        footer: { text: "Automatic claim is armed • Live status every 30 seconds" },
      }, statusMessageId);
    }

    const presentation = {
      heartbeat: { title: "🟣 A1 checker is active", color: 0x8b5cf6 },
      status: { title: "🔵 A1 capacity detected", color: 0x3498db },
      failure: { title: "🟠 A1 claim attempt failed", color: 0xe67e22 },
      success: { title: "✅ OCI A1 instance claimed", color: 0x2ecc71 },
    }[event];
    const fields = [
      { name: "Stack", value: sanitize(this.stackLabel), inline: true },
      { name: "Region", value: sanitize(this.region), inline: true },
    ];
    if (event === "success" && metrics) {
      fields.push(
        { name: "Capacity checks", value: metrics.checksRun.toLocaleString("en-US"), inline: true },
        { name: "RAM at success", value: `${metrics.ramPercent.toFixed(1)}%`, inline: true },
        { name: "CPU at success", value: `${metrics.cpuPercent.toFixed(1)}%`, inline: true },
      );
    }
    await this.send(
      {
        title: presentation.title,
        description: event === "success"
          ? "The A1 instance is running. Automatic claim attempts have stopped."
          : sanitize(summary),
        color: presentation.color,
        fields,
        ...(event === "success"
          ? { footer: { text: "Deployment verified successfully" } }
          : {}),
      },
      event === "success",
    );
    return undefined;
  }

  private async upsertStatus(embed: {
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer?: { text: string };
  }, messageId?: string): Promise<string> {
    const payload = {
      username: "Oracle",
      allowed_mentions: { parse: [] },
      embeds: [{ ...embed, timestamp: new Date().toISOString() }],
    };

    if (messageId) {
      const editUrl = new URL(this.webhookUrl);
      editUrl.pathname = `${editUrl.pathname.replace(/\/$/, "")}/messages/${encodeURIComponent(messageId)}`;
      const response = await this.fetcher(editUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "manual",
      });
      if (response.ok) return messageId;
      if (response.status !== 404) await this.throwDiscordError(response);
    }

    const createUrl = new URL(this.webhookUrl);
    createUrl.searchParams.set("wait", "true");
    const response = await this.fetcher(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    if (!response.ok) await this.throwDiscordError(response);
    const message = await response.json() as { id?: unknown };
    if (typeof message.id !== "string" || !/^\d{17,20}$/.test(message.id)) {
      throw new Error("Discord did not return a valid status message ID");
    }
    return message.id;
  }

  private async send(embed: {
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer?: { text: string };
  }, mentionSuccessUser = false): Promise<void> {
    const content = mentionSuccessUser ? `<@${this.successUserId}>` : undefined;
    await this.post({
      username: "Oracle",
      ...(content ? { content } : {}),
      allowed_mentions: content
        ? { parse: [], users: [this.successUserId] }
        : { parse: [] },
      embeds: [{ ...embed, timestamp: new Date().toISOString() }],
    });
  }

  private async post(payload: object): Promise<void> {
    const response = await this.fetcher(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
    });

    if (!response.ok) await this.throwDiscordError(response);
  }

  private async throwDiscordError(response: Response): Promise<never> {
    const detail = sanitize(await readShortError(response));
    throw new Error(`Discord webhook failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}
