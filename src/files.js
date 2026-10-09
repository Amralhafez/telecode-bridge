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

module.exports = { resolveIn, relOf, list, readFile, isProbablyText, MAX_VIEW_BYTES };
