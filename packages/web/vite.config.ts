import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Dev mode: `pnpm --filter @cube/web dev` serves the UI with HMR and proxies
// /api (including the SSE stream) to a locally running cubed on :7777.
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:7777",
        // The conversation pane is a WebSocket to cubed's pi pty. Without
        // this, HTTP/SSE work in dev mode while the terminal never attaches.
        ws: true,
      },
    },
  },
});
