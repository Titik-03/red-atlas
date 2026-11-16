import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const candidates = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
const python = candidates.find(([command, ...args]) => {
  const result = spawnSync(command, [...args, "-c", "import sys; sys.exit(sys.version_info < (3, 12))"]);
  return !result.error && result.status === 0;
});
if (!python) {
  console.error("RED ATLAS needs Python 3.12 or newer on PATH. Install Python, reopen your terminal, then run npm start again.");
  process.exit(1);
}
const result = spawnSync(python[0], [...python.slice(1), "run.py"], { cwd: root, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
