import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// Server output throughout: every page here reads from the shared SQLite
// file at request time, so nothing can be prerendered.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  // Fly's proxy terminates TLS, so the app sees http while the browser's
  // Origin is https. Trusting Fly's X-Forwarded-Host/Proto lets Astro's
  // CSRF origin check pass for the no-JS character form (it 403'd before).
  security: { allowedDomains: [{ hostname: "*.fly.dev", protocol: "https" }] },
});
