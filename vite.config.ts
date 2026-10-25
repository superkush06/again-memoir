import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const apiPort = env.API_PORT || "3001";
  const webPort = Number(env.WEB_PORT || "5173");
  const https =
    env.TLS_CERT && env.TLS_KEY
      ? { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) }
      : undefined;
  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: webPort,
      strictPort: true,
      watch: { ignored: ["**/data/**", "**/.local/**", "**/spacetimedb/node_modules/**"] },
      https,
      proxy: {
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
        "/uploads": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
        "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
      },
    },
  };
});
