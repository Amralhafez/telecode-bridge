// Safe workspace file browsing. All paths are confined to the repo root —
// no traversal outside it.
const fs = require("fs");
const path = require("path");

const SKIP = new Set([".git", "node_modules", ".next", ".telecode-files", "dist", "build"]);
const MAX_VIEW_BYTES = 60 * 1024;

// Resolve a relative path against root, rejecting anything that escapes root.
function resolveIn(root, rel) {
  const full = path.resolve(root, rel || ".");
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new Error("path escapes workspace");
  }
  return full;
}

function relOf(root, full) {
  const r = path.relative(path.resolve(root), full).replace(/\\/g, "/");
  return r || ".";
}

function list(root, rel) {
  const full = resolveIn(root, rel);
  const st = fs.statSync(full);
  if (!st.isDirectory()) throw new Error("not a directory");
  const entries = fs.readdirSync(full, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else files.push(e.name);
  }
  dirs.sort();
  files.sort();
  return { dirs, files, rel: relOf(root, full) };
}

function readFile(root, rel) {
  const full = resolveIn(root, rel);
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new Error("is a directory");
  const buffer = fs.readFileSync(full);
  return { buffer, size: st.size, name: path.basename(full) };
}

function isProbablyText(buffer) {
  const n = Math.min(buffer.length, 4096);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return false;
  return true;
}

// Read the last `n` lines of a file (for /logs).
function tail(file, n = 40) {
  const data = fs.readFileSync(file, "utf8");
  const lines = data.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

// Search the workspace. Prefers ripgrep, falls back to `git grep`.
const { execFile } = require("child_process");
function search(root, pattern) {
  return new Promise((resolve) => {
    const done = (text, tool) => resolve({ text: (text || "").slice(0, 3500), tool });
    execFile(
      "rg",
      ["--line-number", "--no-heading", "--color", "never", "--max-count", "5", "-S", pattern],
      { cwd: root, timeout: 20000, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (!err || stdout) return done(stdout, "rg");
        execFile(
          "git",
          ["grep", "-n", "-I", "--heading", "-e", pattern],
          { cwd: root, timeout: 20000, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
          (e2, out2) => done(out2, "git grep")
        );
      }
    );
  });
}

module.exports = { resolveIn, relOf, list, readFile, isProbablyText, tail, search, MAX_VIEW_BYTES };
