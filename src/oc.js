const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOST = process.env.OPENCODE_HOST || "127.0.0.1";
const LOG_DIR = path.join(__dirname, "..", "logs");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(password) {
  if (!password) return {};
  return { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") };
}

class OpenCodeServer {
  constructor({ name, dir, port, password }) {
    this.name = name;
    this.dir = dir;
    this.port = port;
    this.password = password;
    this.base = `http://${HOST}:${port}`;
    this.child = null;
    this.adopted = false;
  }

  async healthy(timeoutMs = 2500) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(`${this.base}/global/health`, {
        signal: ctl.signal,
        headers: authHeaders(this.password)
      });
      clearTimeout(t);
      if (!res.ok) return null;
      const j = await res.json();
      return j.healthy ? j : null;
    } catch {
      return null;
    }
  }

  spawn() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const out = fs.openSync(path.join(LOG_DIR, `serve-${this.name}.log`), "a");
    const err = fs.openSync(path.join(LOG_DIR, `serve-${this.name}.err.log`), "a");
    this.child = spawn(
      "opencode",
      ["serve", "--port", String(this.port), "--hostname", HOST],
      {
        cwd: this.dir,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", out, err],
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: this.password || "" }
      }
    );
    this.child.on("exit", (code) => {
      console.error(`[oc:${this.name}] serve exited (code=${code})`);
      this.child = null;
    });
    return (async () => {
      for (let i = 0; i < 60; i++) {
        const h = await this.healthy();
        if (h) return { adopted: false, health: h };
        await sleep(500);
      }
      throw new Error(`[${this.name}] opencode serve not healthy after 30s (check logs/serve-${this.name}.err.log)`);
    })();
  }

  async ensure() {
    const h = await this.healthy();
    if (h) {
      this.adopted = true;
      return { adopted: true, health: h };
    }
    return this.spawn();
  }

  async api(method, p, body) {
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...authHeaders(this.password)
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`oc[${this.name}] ${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  listSessions() {
    return this.api("GET", "/session");
  }
  createSession(title) {
    return this.api("POST", "/session", { title });
  }
  deleteSession(id) {
    return this.api("DELETE", `/session/${id}`);
  }
  abortSession(id) {
    return this.api("POST", `/session/${id}/abort`);
  }
  sessionStatuses() {
    return this.api("GET", "/session/status");
  }
  getMessage(sid, mid) {
    return this.api("GET", `/session/${sid}/message/${mid}`);
  }
  sessionDetail(sid) {
    return this.api("GET", `/session/${sid}`);
  }
  sessionDiff(sid) {
    return this.api("GET", `/session/${sid}/diff`);
  }
  sessionTodo(sid) {
    return this.api("GET", `/session/${sid}/todo`);
  }
  shareSession(sid) {
    return this.api("POST", `/session/${sid}/share`);
  }
  revertSession(sid, messageID) {
    return this.api("POST", `/session/${sid}/revert`, { messageID });
  }
  promptAsync(sid, parts, opts = {}) {
    const body = { parts };
    if (opts.agent) body.agent = opts.agent;
    if (opts.model) {
      const [providerID, modelID] = opts.model.split("/");
      if (providerID && modelID) body.model = { providerID, modelID };
    }
    return this.api("POST", `/session/${sid}/prompt_async`, body);
  }
  pendingPermissions() {
    return this.api("GET", "/permission");
  }
  pendingQuestions() {
    return this.api("GET", "/question");
  }
  replyPermission(requestId, reply, message) {
    return this.api("POST", `/permission/${requestId}/reply`, message ? { reply, message } : { reply });
  }
  replyQuestion(requestId, answers) {
    return this.api("POST", `/question/${requestId}/reply`, { answers });
  }
  rejectQuestion(requestId) {
    return this.api("POST", `/question/${requestId}/reject`);
  }

  watchEvents(onEvent) {
    let backoff = 2000;
    let stopped = false;

    async function loop(self) {
      while (!stopped) {
        try {
          const res = await fetch(`${self.base}/event`, {
            headers: { accept: "text/event-stream", ...authHeaders(self.password) }
          });
          if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
          backoff = 2000;
          const decoder = new TextDecoder();
          let buf = "";
          for await (const chunk of res.body) {
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
                  console.error(`[oc:${self.name}] bad event payload:`, e.message);
                }
              }
            }
          }
        } catch (e) {
          if (stopped) return;
          console.error(`[oc:${self.name}] event stream error: ${e.message}`);
        }
        if (!stopped) {
          const wait = Math.min(backoff, 30000);
          await sleep(wait);
          backoff = Math.min(backoff * 2, 30000);
        }
      }
    }
    loop(this);
    return () => {
      stopped = true;
    };
  }
}

class ServerManager {
  constructor(password) {
    this.password = password || "";
    this.instances = new Map();
  }

  register(name, dir, port) {
    const existing = this.instances.get(name);
    if (existing && existing.dir === dir && existing.port === port) return existing;
    const inst = new OpenCodeServer({ name, dir, port, password: this.password });
    this.instances.set(name, inst);
    return inst;
  }

  get(name) {
    return this.instances.get(name);
  }

  allocPort() {
    let max = 4095;
    for (const s of this.instances.values()) max = Math.max(max, s.port);
    return max + 1;
  }

  async ensureAll() {
    for (const s of this.instances.values()) await s.ensure();
  }

  startWatchdog(onRespawn) {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        for (const s of this.instances.values()) {
          if (await s.healthy(2000)) continue;
          console.warn(`[oc:${s.name}] watchdog: unhealthy, respawning…`);
          try {
            await s.spawn();
            console.log(`[oc:${s.name}] watchdog: server back`);
            if (typeof onRespawn === "function") {
              try {
                onRespawn(s.name);
              } catch {}
            }
          } catch (e) {
            console.error(`[oc:${s.name}] watchdog respawn failed:`, e.message);
          }
        }
      } finally {
        busy = false;
      }
    }, 15000).unref();
  }
}

module.exports = { OpenCodeServer, ServerManager, HOST, sleep };
