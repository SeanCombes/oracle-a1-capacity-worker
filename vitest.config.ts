import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OCI_TENANCY_OCID: "test-tenancy",
          OCI_USER_OCID: "test-user",
          OCI_KEY_FINGERPRINT: "00:00:00:00",
          OCI_PRIVATE_KEY: "test-private-key",
          OCI_STACK_OCID: "test-stack",
          DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test/test",
          DISCORD_SUCCESS_USER_ID: "100000000000000000",
          ADMIN_TOKEN: "test-admin-token",
          NOTIFY_TOKEN: "test-notify-token",
        },
      },
    }),
  ],
});
