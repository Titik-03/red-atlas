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
  let down: string | null = null;   // why the builder is not running; sent to the app so the card can say what to do
  return {
    name: "red-atlas-site-server",
    apply: "serve",
    configureServer(server) {
      if (!server.httpServer) return;   // middleware-mode tools (check-globe, audit-readout) need no site server
      const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
      // The venv keeps Python in bin/ on Linux and macOS, in Scripts\ on Windows.
      const py = [".venv/bin/python", ".venv/Scripts/python.exe"].map((f) => resolve(root, f)).find(existsSync);
      server.middlewares.use("/api", (_req, res, next) => {
        if (!down) return next();
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: down }));
      });
      const sock = net.connect(SITE_PORT, "127.0.0.1");
      sock.on("connect", () => { sock.destroy(); server.config.logger.info(`  site server already running on :${SITE_PORT}`); });
      sock.on("error", () => {
        if (!py) {
          down = "The Python environment is missing on this computer. One-time setup, from the project folder: "
            + "python3 -m venv .venv && .venv/bin/pip install rasterio numpy pyyaml pillow matplotlib cmcrameri "
            + "&& .venv/bin/python pipeline/build_globe.py (downloads about 1.2 GB). Then restart npm run dev.";
          server.config.logger.warn(`  site server not started: ${down}`);
          return;
        }
        let tail = "";
        child = spawn(py, ["pipeline/site_server.py", "--port", String(SITE_PORT)], { cwd: root, stdio: ["ignore", "inherit", "pipe"] });
        child.stderr?.on("data", (d) => { process.stderr.write(d); tail = (tail + d).slice(-600); });
        child.on("exit", (code) => {
          child = null;
          if (!code) return;
          const last = tail.trim().split("\n").pop() ?? "";
          down = `The site builder stopped (${last || `exit code ${code}`}).`
            + (/No module named/.test(last) ? " Install the Python packages listed in the README into .venv, then restart npm run dev." : " Restart npm run dev.");
          server.config.logger.error(`  ${down}`);
        });
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
