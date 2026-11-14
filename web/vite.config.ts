import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_PORT = 8765;

/** Starts pipeline/site_server.py with `npm run dev` (unless one is already listening), stops it on exit. */
function siteServer(): Plugin {
  let child: ChildProcess | null = null;
  return {
    name: "red-atlas-site-server",
    apply: "serve",
    configureServer(server) {
      if (!server.httpServer) return;   // middleware-mode tools (check-globe, audit-readout) need no site server
      const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
      const py = resolve(root, ".venv/bin/python");
      const sock = net.connect(SITE_PORT, "127.0.0.1");
      sock.on("connect", () => { sock.destroy(); server.config.logger.info(`  site server already running on :${SITE_PORT}`); });
      sock.on("error", () => {
        if (!existsSync(py)) {
          server.config.logger.warn(`  site server not started: ${py} missing (create the venv, see README)`);
          return;
        }
        child = spawn(py, ["pipeline/site_server.py", "--port", String(SITE_PORT)], { cwd: root, stdio: "inherit" });
        child.on("exit", (code) => { if (code) server.config.logger.error(`  site server exited (${code})`); child = null; });
      });
      const stop = () => { child?.kill(); child = null; };
      server.httpServer?.on("close", stop);
      process.once("exit", stop);
      process.once("SIGINT", () => { stop(); process.exit(0); });
      process.once("SIGTERM", () => { stop(); process.exit(0); });
    },
  };
}

// /api -> pipeline/site_server.py (on-demand "Land here" site builder)
export default defineConfig({
  plugins: [react(), siteServer()],
  server: { proxy: { "/api": `http://127.0.0.1:${SITE_PORT}` } },
});
