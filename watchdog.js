const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const dir = __dirname;
const lock = path.join(dir, "bridge.lock");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let pid = 0;
try {
  pid = parseInt(fs.readFileSync(lock, "utf8"), 10);
} catch {}
if (pid && alive(pid)) {
  console.log(`[watchdog] bridge alive (pid ${pid})`);
  process.exit(0);
}

fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
const out = fs.openSync(path.join(dir, "logs", "bridge-task.log"), "a");
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: dir,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", out, out]
});
child.unref();
console.log(`[watchdog] bridge spawned pid ${child.pid}`);
