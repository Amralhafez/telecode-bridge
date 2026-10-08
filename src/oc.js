const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOST = process.env.OPENCODE_HOST || "127.0.0.1";
const PORT = Number(process.env.OPENCODE_PORT || 4096);
const WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();
const BASE = `http://${HOST}:${PORT}`;

const LOG_DIR = path.join(__dirname, "..", "logs");
let spawned = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function healthy(timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${BASE}/global/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return j.healthy ? j : null;
  } catch {
    return null;
  }
}

async function ensureServer() {
  const existing = await healthy();
  if (existing) return { adopted: true, health: existing };
  return spawnServer();
}

async function spawnServer() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOG_DIR, "opencode-serve.log"), "a");
  const err = fs.openSync(path.join(LOG_DIR, "opencode-serve.err.log"), "a");
  spawned = spawn(
    "opencode",
    ["serve", "--port", String(PORT), "--hostname", HOST],
    { cwd: WORKSPACE, shell: true, windowsHide: true, stdio: ["ignore", out, err] }
  );
  spawned.on("exit", (code) => {
    console.error(`[oc] opencode serve exited (code=${code})`);
    spawned = null;
  });

  for (let i = 0; i < 60; i++) {
    const h = await healthy();
    if (h) return { adopted: false, health: h };
    await sleep(500);
  }
  throw new Error("opencode serve did not become healthy within 30s");
}

function startWatchdog() {
  let ensuring = false;
  setInterval(async () => {
    if (ensuring) return;
    const h = await healthy(2000);
    if (h) return;
    ensuring = true;
    console.warn("[oc] watchdog: server unhealthy, respawning…");
    try {
      await spawnServer();
      console.log("[oc] watchdog: server back");
    } catch (e) {
      console.error("[oc] watchdog respawn failed:", e.message);
    } finally {
      ensuring = false;
    }
  }, 15000).unref();
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`oc ${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

const listSessions = () => api("GET", "/session");
const createSession = (title) => api("POST", "/session", { title });
const deleteSession = (id) => api("DELETE", `/session/${id}`);
const abortSession = (id) => api("POST", `/session/${id}/abort`);
const sessionStatuses = () => api("GET", "/session/status");
const getMessage = (sid, mid) => api("GET", `/session/${sid}/message/${mid}`);

const promptAsync = (sid, text) =>
  api("POST", `/session/${sid}/prompt_async`, {
    parts: [{ type: "text", text }]
  });

const pendingPermissions = () => api("GET", "/permission");
const pendingQuestions = () => api("GET", "/question");

const replyPermission = (requestId, reply, message) =>
  api("POST", `/permission/${requestId}/reply`, message ? { reply, message } : { reply });

const replyQuestion = (requestId, answers) =>
  api("POST", `/question/${requestId}/reply`, { answers });

const rejectQuestion = (requestId) =>
  api("POST", `/question/${requestId}/reject`);

function watchEvents(onEvent) {
  let backoff = 2000;
  let stopped = false;

  async function loop() {
    while (!stopped) {
      const ctl = new AbortController();
      let lastData = Date.now();
      try {
        const res = await fetch(`${BASE}/event`, {
          headers: { accept: "text/event-stream" },
          signal: ctl.signal
        });
        if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
        backoff = 2000;
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          lastData = Date.now();
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                onEvent(JSON.parse(payload));
              } catch (e) {
                console.error("[oc] bad event payload:", e.message);
              }
            }
          }
        }
      } catch (e) {
        if (stopped) return;
        console.error(`[oc] event stream error: ${e.message}`);
      }
      try {
        ctl.abort();
      } catch {}
      if (!stopped) {
        const idle = Date.now() - lastData;
        const wait = Math.min(backoff, 30000);
        console.log(`[oc] reconnecting event stream in ${wait}ms`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
  loop();
  return () => {
    stopped = true;
  };
}

module.exports = {
  startWatchdog,
  BASE,
  ensureServer,
  api,
  listSessions,
  createSession,
  deleteSession,
  abortSession,
  sessionStatuses,
  getMessage,
  promptAsync,
  pendingPermissions,
  pendingQuestions,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  watchEvents
};

