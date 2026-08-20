# Oracle A1 Capacity Worker

A Cloudflare Worker that retries one existing OCI Resource Manager stack until its `APPLY` job succeeds. It uses a SQLite-backed Durable Object for strong coordination, OCI request signatures for authentication, and a Discord webhook for deduplicated notifications.

It does **not** create or modify your VCN, subnet, security lists, SSH keys, or Terraform stack. The configured stack remains the source of truth.

## Behavior

| OCI state | Action |
|---|---|
| No Apply job | Create one `AUTO_APPROVED` Apply job |
| `ACCEPTED`, `IN_PROGRESS`, `CANCELING` | Report the state to Discord; never create a duplicate |
| `FAILED` with out-of-capacity details | Send a compact no-mention Discord embed as `Oracle`, record the retry, and create a new Apply job |
| Other `FAILED` state | Send one Discord warning per distinct error and pause for 6 hours |
| `CANCELED` | Create a new Apply job |
| `SUCCEEDED` | Persist terminal success, notify Discord once, and stop creating jobs |
| OCI 408, 429, or 5xx | Retry silently; a throttled `CreateJob` is deferred instead of repeated immediately |
| OCI 400, 401, 403, 404, or unexpected response | Notify once and pause |

The 20-minute Cron is a recovery backstop. A Durable Object alarm checks active jobs after 2 minutes and retries transient OCI failures after at least 5 minutes. Apply creation has a persistent 20-minute cooldown, matching the requested retry interval. Discord reports confirmed capacity failures and success; transient and routine states stay quiet.

Before every creation request, the Worker lists OCI jobs for the stack. This is the external idempotency boundary. The Durable Object adds a local execution gate, a persistent lease, and a stable OCI retry token, so overlapping Cron/manual runs and ambiguous POST timeouts do not produce duplicate Apply jobs.

OCI requests are paced at least one second apart. Reads and retryable server failures use exponential backoff with jitter. A `CreateJob` response of `429` is not repeated in the same run; its stable retry token is persisted and the Durable Object honors OCI's `Retry-After` header, with a five-minute minimum transient delay.

## Project layout

- `src/index.ts` — Cron and HTTP handlers.
- `src/coordinator.ts` — SQLite-backed Durable Object and RPC methods.
- `src/engine.ts` — deployment state machine, lease, retry, and notification rules.
- `src/oci-signing.ts` — OCI Signature Version 1 with Web Crypto RSA-SHA256.
- `src/oci-client.ts` — bounded OCI Resource Manager REST client.
- `src/discord.ts` — sanitized Discord embeds.
- `test/` — mocked OCI/Discord, signing, concurrency, Durable Object, endpoint, and Cron tests.

## Required OCI values

Use a dedicated OCI automation user and API signing key. The API signing key is **not** the Minecraft VM's SSH key.

Current Oracle Console paths:

| Value | Console path |
|---|---|
| Tenancy OCID | Profile menu → **Tenancy: _name_** → Tenancy Information |
| User OCID | Profile menu → **User settings** → User Information |
| API key and fingerprint | Profile menu → **User settings** → **Token and keys / API Keys** |
| Region identifier | Top navigation region selector; use `eu-stockholm-1` for Stockholm |
| Stack OCID | ☰ → **Developer Services** → **Resource Manager** → **Stacks** → `minecraft-server` |
| IAM policy | ☰ → **Identity & Security** → **Identity** → **Policies** |

The stack must already reference the existing `minecraft-vcn`, public subnet, SSH public key, Ubuntu ARM image, and `VM.Standard.A1.Flex` configuration.

## Least-privilege OCI policy

Create a dedicated group such as `MinecraftCapacityAutomation`, add only the automation user, and create these policies in the stack's compartment. Replace the placeholders:

```text
Allow group <identity-domain>/<group-name> to use orm-stacks in compartment <compartment-name> where target.stack.id = '<stack-ocid>'
Allow group <identity-domain>/<group-name> to read orm-jobs in compartment <compartment-name> where target.stack.id = '<stack-ocid>'
Allow group <identity-domain>/<group-name> to manage orm-jobs in compartment <compartment-name> where all {target.stack.id = '<stack-ocid>', target.job.operation = 'APPLY'}
```

For a tenancy without identity domains, use `Allow group <group-name> ...`. OCI documents that `CreateJob` requires both `ORM_JOB_MANAGE` and `ORM_STACK_USE`; reading failed-job logs requires `ORM_JOB_READ`.

If OCI rejects `ListJobs` because your tenancy does not evaluate `target.stack.id` for list filtering, broaden only the read statement to:

```text
Allow group <identity-domain>/<group-name> to read orm-jobs in compartment <compartment-name>
```

Do not grant `manage all-resources`.

## API signing key

The Worker accepts Oracle's console-generated unencrypted PKCS#8 PEM:

```text
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
OCI_API_KEY
```

1. Open the automation user's **API Keys** page.
2. Select **Add API Key → Generate API Key Pair**.
3. Download the private key once and finish adding the public key.
4. Copy the configuration preview's tenancy OCID, user OCID, fingerprint, and region.
5. Store the private key only in Cloudflare's encrypted secret. Protect and remove the local copy after deployment.

Encrypted/passphrase-protected keys and `BEGIN RSA PRIVATE KEY` (PKCS#1) are deliberately rejected. Cloudflare cannot securely prompt for a passphrase during Cron execution. Rotate by adding a new OCI API key, updating the three matching Worker secrets, verifying operation, and then deleting the old API key from OCI.

## Local verification on Windows

Requires Node.js 22 or newer. In PowerShell:

```powershell
Set-Location 'C:\Users\Ascender\Documents\Codex\2026-07-28\referenced-chatgpt-conversation-this-is-untrusted-2\outputs\oracle-a1-capacity-worker'
npm.cmd install
npm.cmd run cf-typegen
npm.cmd run verify
```

`verify` performs generated-type validation, strict TypeScript checking, 40 mocked tests, a Wrangler dry run, and Worker startup profiling. `test/fixtures/verify-secrets.env` contains invalid test-only placeholders; it cannot authenticate to OCI or Discord.

To run only the mocked scheduled/endpoint tests:

```powershell
npm.cmd test
```

No local verification command contacts real OCI or Discord.

## Initial Cloudflare deployment

### 1. Confirm the Cloudflare account

```powershell
npx.cmd wrangler login
npx.cmd wrangler whoami
```

Do not continue until `whoami` shows the intended account.

### 2. Create a protected local secrets file

Create `.env.production` in the project folder. It is ignored by Git:

```dotenv
OCI_TENANCY_OCID="replace"
OCI_USER_OCID="replace"
OCI_KEY_FINGERPRINT="replace"
OCI_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
replace
-----END PRIVATE KEY-----
OCI_API_KEY"
OCI_STACK_OCID="replace"
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/replace"
DISCORD_SUCCESS_USER_ID="replace-with-discord-user-id"
ADMIN_TOKEN="replace-with-at-least-32-random-characters"
```

Restrict the file to your Windows account:

```powershell
$secretFile = Resolve-Path '.env.production'
icacls.exe $secretFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

Never paste this file into chat, logs, screenshots, Git, or command arguments.

### 3. Recheck without external changes

```powershell
npm.cmd run verify
npx.cmd wrangler deploy --dry-run --secrets-file .env.production
```

### 4. Deploy code, Durable Object migration, Cron, and secrets

This command creates Cloudflare resources and activates the 20-minute schedule:

```powershell
npx.cmd wrangler deploy --secrets-file .env.production
```

The Durable Object namespace and its SQLite migration come from `wrangler.jsonc`; no separate namespace command is required. Cron expressions run in UTC and may take several minutes to propagate.

After deployment, securely remove the temporary secrets file:

```powershell
Remove-Item -LiteralPath '.env.production'
```

### Secret rotation

Text secrets can be updated interactively without placing values in command arguments:

```powershell
npx.cmd wrangler secret put DISCORD_WEBHOOK_URL
npx.cmd wrangler secret put DISCORD_SUCCESS_USER_ID
npx.cmd wrangler secret put ADMIN_TOKEN
```

For a multiline private key, use a protected PEM file:

```powershell
Get-Content -Raw -LiteralPath 'C:\secure\oci_api_key.pem' | npx.cmd wrangler secret put OCI_PRIVATE_KEY
```

Update `OCI_KEY_FINGERPRINT` immediately afterward if the key changed.

## Verification after deployment

The production Worker and OCI Apply flow were verified live on 2026-07-28.

1. Open the Worker URL's safe health endpoint:

```powershell
Invoke-RestMethod 'https://oracle-a1-capacity-worker.<your-subdomain>.workers.dev/health'
```

2. Stream sanitized logs:

```powershell
npx.cmd wrangler tail oracle-a1-capacity-worker --format json
```

3. In Cloudflare, open **Workers & Pages → oracle-a1-capacity-worker → Settings → Trigger Events → View events**. Wait for the next `*/20 * * * *` Cron event.

4. Confirm OCI under **Developer Services → Resource Manager → Jobs**. There must be at most one active Apply job for the stack.

5. A manual run creates or checks a real OCI job. Use it only after confirming the stack and IAM policy:

```powershell
$workerUrl = 'https://oracle-a1-capacity-worker.<your-subdomain>.workers.dev'
$adminToken = Read-Host 'ADMIN_TOKEN'
$headers = @{ Authorization = "Bearer $adminToken" }
Invoke-RestMethod -Method Post -Uri "$workerUrl/run" -Headers $headers
```

The response reports only a safe outcome and lifecycle state.

## Success, reset, and disabling Cron

When `/health` shows both `terminalSuccess: true` and `successNotified: true`, no new Apply jobs will be created. You can leave Cron enabled; subsequent runs are passive.

To disable Cron completely, change `wrangler.jsonc` to:

```jsonc
"triggers": {
  "crons": []
}
```

Then deploy:

```powershell
npx.cmd wrangler deploy
```

To deliberately clear terminal state and resume retries:

```powershell
$workerUrl = 'https://oracle-a1-capacity-worker.<your-subdomain>.workers.dev'
$adminToken = Read-Host 'ADMIN_TOKEN'
$headers = @{ Authorization = "Bearer $adminToken" }
Invoke-RestMethod -Method Post -Uri "$workerUrl/reset" -Headers $headers
```

Reset does not immediately create an OCI job, but the next Cron or manual `/run` can.

## Rollback

```powershell
npx.cmd wrangler versions list
npx.cmd wrangler rollback <VERSION_ID>
```

A code rollback does not erase Durable Object state. Avoid rolling back past the `v1` Durable Object migration.

## Troubleshooting

- **401 from OCI:** check tenancy OCID, user OCID, fingerprint, PKCS#8 key, and Worker/OCI clock assumptions.
- **403 from OCI:** verify group membership and the three Resource Manager policy statements.
- **404 from OCI:** verify `OCI_STACK_OCID` and `OCI_REGION`.
- **Out of host capacity:** expected; a compact no-mention Discord embed is sent as `Oracle` and a new Apply is started.
- **Discord 401/404:** rotate `DISCORD_WEBHOOK_URL`.
- **Automation paused:** inspect the sanitized Discord error and logs. Fix the cause, then wait six hours or use the protected reset endpoint.
- **Success but no Discord message:** keep Cron enabled; notification is retried without creating another Apply job.
- **Generated types changed:** run `npm.cmd run cf-typegen`, review `worker-configuration.d.ts`, and rerun `npm.cmd run verify`.

## Security notes

- All credentials and the Discord notification user ID are required Worker secrets; only region, stack label, cooldown, and lease duration are plaintext variables.
- OCI and Discord redirects are disabled so authorization data is not forwarded.
- OCI response bodies and job logs are read with strict size limits.
- Logs redact full OCIDs, URLs, signatures, and webhook details.
- `/run` and `/reset` are POST-only and compare a hashed bearer token with `crypto.subtle.timingSafeEqual`.
- Discord mentions are disabled for failures and restricted to `DISCORD_SUCCESS_USER_ID` for the one-time success notification.

References: [OCI request signing](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm), [OCI API signing keys](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm), [OCI Resource Manager policy reference](https://docs.oracle.com/en-us/iaas/Content/Identity/policyreference/resourcemanagerpolicyreference.htm), [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), and [Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
Adding this for cloudflare worker purposes.
