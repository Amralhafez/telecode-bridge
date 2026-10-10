// GitHub integration via the `gh` CLI (optional — degrades gracefully).
const { execFile } = require("child_process");

function gh(dir, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd: dir, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function available() {
  try {
    await gh(process.cwd(), ["--version"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function ciStatus(dir) {
  const { stdout } = await gh(dir, ["run", "list", "--limit", "3", "--json", "status,conclusion,displayTitle,workflowName"]);
  return JSON.parse(stdout || "[]");
}

async function listPRs(dir) {
  const { stdout } = await gh(dir, ["pr", "list", "--limit", "10", "--json", "number,title,state,headRefName"]);
  return JSON.parse(stdout || "[]");
}

async function createIssue(dir, title, body) {
  const { stdout } = await gh(dir, ["issue", "create", "--title", title, "--body", body || ""]);
  return stdout.trim();
}

module.exports = { gh, available, ciStatus, listPRs, createIssue };
