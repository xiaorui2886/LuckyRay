import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { checkoutIdentity } from "./scripts/dev-frontend.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), {
    name: "luckyray-dev-checkout",
    configureServer(server) {
      const checkout = checkoutIdentity(server.config.root);
      server.middlewares.use("/__luckyray_dev", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ checkout }));
      });
    },
  }],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
