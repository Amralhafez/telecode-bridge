// Thin git helper — runs git in a given working directory, no shell injection.
const { execFile } = require("child_process");

function git(dir, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: dir, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function isRepo(dir) {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

// List of changed files (porcelain), returns [{status, path}]
async function changes(dir) {
  const { stdout } = await git(dir, ["status", "--porcelain"]);
  return stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
}

// Build a conventional-ish commit message from the current changes.
function suggestMessage(changed) {
  if (!changed.length) return "chore: update";
  const names = changed.map((c) => c.path.split(/[\\/]/).pop());
  const head = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` (+${names.length - 3} more)` : "";
  return `chore: update ${head}${extra}`;
}

async function commitAll(dir, message) {
  await git(dir, ["add", "-A"]);
  const { stdout } = await git(dir, ["commit", "-m", message]);
  return stdout.trim();
}

async function currentBranch(dir) {
  const { stdout } = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

async function hasUpstream(dir) {
  try {
    await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return true;
  } catch {
    return false;
  }
}

async function push(dir) {
  const branch = await currentBranch(dir);
  const args = (await hasUpstream(dir)) ? ["push"] : ["push", "-u", "origin", branch];
  const { stdout, stderr } = await git(dir, args, { timeout: 120000 });
  return (stdout + stderr).trim();
}

async function clone(url, targetDir) {
  await git(process.cwd(), ["clone", url, targetDir], { timeout: 300000 });
}

async function branches(dir) {
  const { stdout } = await git(dir, ["branch", "--format=%(refname:short)"]);
  const list = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const current = await currentBranch(dir);
  return { list, current };
}

async function checkout(dir, name) {
  await git(dir, ["checkout", name]);
}

async function createBranch(dir, name) {
  await git(dir, ["checkout", "-b", name]);
}

async function remoteUrl(dir) {
  try {
    const { stdout } = await git(dir, ["remote", "get-url", "origin"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

// Build a "create PR" web URL for a GitHub remote + branch, else "".
function prUrl(remote, branch) {
  if (!remote) return "";
  let m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!m) return "";
  const owner = m[1];
  const repo = m[2];
  return `https://github.com/${owner}/${repo}/pull/new/${encodeURIComponent(branch)}`;
}

module.exports = {
  git, isRepo, changes, suggestMessage, commitAll, currentBranch, hasUpstream, push, clone,
  branches, checkout, createBranch, remoteUrl, prUrl
};
