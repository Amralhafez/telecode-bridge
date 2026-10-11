// Adapters for CLI coding agents: Claude Code (`claude`) and Codex (`codex`).
// Unlike opencode (a live HTTP server), these run per-prompt. We spawn them in
// print/stream mode, parse their output, and relay text + tool activity.
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function has(cmd) {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    execFile(probe, [cmd], { windowsHide: true }, (err) => resolve(!err));
  });
}

// Encode a workspace path the way Claude Code names its project folder:
// C:\Users\me\app  ->  C--Users-me-app
function claudeProjectDir(cwd) {
  const enc = cwd.replace(/[:\\/]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", enc);
}

// List saved Claude Code sessions for a workspace (read-only, from .jsonl files).
function listClaudeSessions(cwd, limit = 15) {
  const dir = claudeProjectDir(cwd);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    out.push({ id: f.replace(/\.jsonl$/, ""), mtime: stat.mtimeMs, title: sessionTitle(full) });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

function sessionTitle(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const l of lines.slice(0, 8)) {
      try {
        const o = JSON.parse(l);
        if (o.type === "summary" && o.summary) return String(o.summary).slice(0, 60);
      } catch {}
    }
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.type === "user" && o.message) {
          const c = o.message.content;
          const t = typeof c === "string" ? c : (c || []).filter((x) => x.type === "text").map((x) => x.text).join(" ");
          if (t && t.trim()) return t.trim().slice(0, 60);
        }
      } catch {}
    }
  } catch {}
  return "(untitled)";
}

// Run Claude Code headless. onEvent gets {type:session|text|tool|result|error}.
// Returns { child, done } — done resolves when the run finishes.
function runClaude({ dir, prompt, sessionId, yolo, approval, onEvent }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (yolo) {
    args.push("--dangerously-skip-permissions");
  } else if (approval && approval.configPath) {
    // Interactive approvals: route permission prompts to our MCP tool, which
    // asks the owner on Telegram.
    args.push("--permission-mode", "default", "--mcp-config", approval.configPath, "--permission-prompt-tool", "mcp__telecode__approve");
  } else {
    args.push("--permission-mode", "acceptEdits");
  }
  if (sessionId) args.push("--resume", sessionId);
  const child = spawn("claude", args, { cwd: dir, shell: true, windowsHide: true });
  const done = parseStream(child, onEvent, "claude");
  writeStdin(child, prompt);
  return { child, done };
}

// Run Codex headless via `codex exec --json`. Safety is sandbox-based:
// YOLO -> full bypass; otherwise a workspace-write sandbox (edits the repo,
// can't escape it) with no interactive prompts so it doesn't hang.
function runCodex({ dir, prompt, sessionId, yolo, onEvent }) {
  const opts = ["--json", "--skip-git-repo-check"];
  opts.push(...(yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"]));
  const args = sessionId ? ["exec", ...opts, "resume", sessionId] : ["exec", ...opts];
  const child = spawn("codex", args, { cwd: dir, shell: true, windowsHide: true });
  const done = parseStream(child, onEvent, "codex");
  writeStdin(child, prompt);
  return { child, done };
}

function writeStdin(child, prompt) {
  try {
    child.stdin.write(prompt);
    child.stdin.end();
  } catch {}
}

function parseStream(child, onEvent, kind) {
  return new Promise((resolve) => {
    let buf = "";
    let plain = "";
    let finished = false;
    const emit = (e) => {
      try {
        onEvent(e);
      } catch {}
    };
    const handleObj = (o) => {
      if (!o || typeof o !== "object") return;
      // Claude Code stream-json
      if (o.type === "system" && o.subtype === "init" && o.session_id) emit({ type: "session", id: o.session_id });
      else if (o.type === "assistant" && o.message) {
        for (const p of o.message.content || []) {
          if (p.type === "text" && p.text) emit({ type: "text", text: p.text });
          else if (p.type === "tool_use") emit({ type: "tool", label: toolLabel(p) });
        }
      } else if (o.type === "result") {
        emit({ type: "result", text: o.result || "", cost: o.total_cost_usd || 0, isError: Boolean(o.is_error) });
      }
      // Codex `exec --json` events.
      else if (kind === "codex") {
        if (o.type === "thread.started" && o.thread_id) {
          emit({ type: "session", id: o.thread_id });
        } else if (o.type === "item.completed" && o.item) {
          const it = o.item;
          if (it.type === "agent_message" && it.text) emit({ type: "text", text: it.text });
          else if (it.type === "reasoning") {
            /* skip chain-of-thought */
          } else if (it.type) {
            const lbl = it.command || it.cmd || it.path || it.text || it.type;
            emit({ type: "tool", label: String(lbl).slice(0, 100) });
          }
        } else if (o.type === "turn.completed") {
          emit({ type: "result", text: "", cost: 0 });
        } else if (o.type === "error" || o.type === "turn.failed") {
          emit({ type: "error", message: String(o.message || o.error || "codex error") });
        }
      }
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          handleObj(JSON.parse(line));
        } catch {
          plain += line + "\n"; // not JSON — keep as plain fallback
        }
      }
    });
    let errbuf = "";
    child.stderr.on("data", (d) => {
      errbuf += d.toString();
    });
    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (buf.trim()) {
        try {
          handleObj(JSON.parse(buf.trim()));
        } catch {
          plain += buf;
        }
      }
      resolve({ code, plain: plain.trim(), stderr: errbuf.trim() });
    };
    child.on("close", finish);
    child.on("error", (e) => {
      emit({ type: "error", message: e.message });
      finish(-1);
    });
  });
}

function toolLabel(p) {
  const i = p.input || {};
  const arg = i.command || i.file_path || i.path || i.pattern || i.url || i.description || "";
  return `${p.name}${arg ? " — " + String(arg).slice(0, 100) : ""}`;
}

module.exports = { has, runClaude, runCodex, listClaudeSessions, claudeProjectDir };
