require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Bot, InlineKeyboard } = require("grammy");
const { ServerManager } = require("./oc");
const state = require("./state");
const { mdToHtml, splitHtml, esc, fmtDiff, fmtTodos, fmtCost } = require("./format");
const { TurnView, editSafe } = require("./stream");
const media = require("./media");

const OWNER = String(process.env.TELEGRAM_OWNER_ID || "");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";
if (!TOKEN || !OWNER) {
  console.error("[bridge] TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID are required");
  process.exit(1);
}

const lockFile = path.join(__dirname, "..", "bridge.lock");
try {
  const prev = parseInt(fs.readFileSync(lockFile, "utf8"), 10);
  if (prev && prev !== process.pid) {
    try {
      process.kill(prev, 0);
      console.error(`[bridge] already running as PID ${prev} — exiting`);
      process.exit(0);
    } catch {}
  }
} catch {}
fs.writeFileSync(lockFile, String(process.pid));
process.on("exit", () => {
  try {
    if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.unlinkSync(lockFile);
  } catch {}
});

const sentMessages = new Set();
const toolSeen = new Set();
const expectingTurn = new Set();
const retryNotified = new Set();
const pendingAsks = new Map();
const pendingInput = new Map();
const turnViews = new Map();
let bot;
let manager;

const ownerChat = () => state.get().chatId || Number(OWNER);
const activeRepoName = () => state.get().activeRepo || Object.keys(state.get().repos)[0];

async function push(chatId, html, extra = {}) {
  const outs = [];
  for (const part of splitHtml(html)) {
    try {
      outs.push(await bot.api.sendMessage(chatId, part, { parse_mode: "HTML", ...extra }));
    } catch (e) {
      console.error("[tg] sendMessage failed:", e.message);
      try {
        outs.push(await bot.api.sendMessage(chatId, part.replace(/<[^>]+>/g, ""), extra));
      } catch (e2) {
        console.error("[tg] sendMessage plain failed:", e2.message);
      }
    }
  }
  return outs;
}

async function activeSession(repo) {
  const sid = state.get().activeSessions[repo];
  const inst = manager.get(repo);
  if (sid) {
    try {
      const sessions = await inst.listSessions();
      if (sessions.some((s) => s.id === sid)) return sid;
    } catch {}
  }
  const s = await inst.createSession(`tg ${new Date().toISOString().slice(0, 16)}`);
  state.set({ activeSessions: { ...state.get().activeSessions, [repo]: s.id } });
  return s.id;
}

function turnKey(repo, sid) {
  return `${repo}|${sid}`;
}

async function startNewSession(chatId, text, { runAsPrompt = false } = {}) {
  const repo = activeRepoName();
  const inst = manager.get(repo);
  if (!inst) {
    await push(chatId, "⚠️ ما في ريبو فعّال — استخدم /repo أول.");
    return null;
  }
  const title = (text && text.trim() ? text.trim() : `tg ${new Date().toISOString().slice(0, 16)}`).slice(0, 80);
  let s;
  try {
    s = await inst.createSession(title);
  } catch (e) {
    await push(chatId, `⚠️ ما قدرت أفتح جلسة: <code>${esc(e.message)}</code>`);
    return null;
  }
  state.set({ activeSessions: { ...state.get().activeSessions, [repo]: s.id } });
  await push(chatId, `🆕 [${esc(repo)}] جلسة جديدة: <b>${esc(title)}</b>\n<code>${esc(s.id)}</code>`);
  if (runAsPrompt && text && text.trim()) await sendPrompt(chatId, [{ type: "text", text: text.trim() }]);
  return s;
}

async function sendPrompt(chatId, parts, opts = {}) {
  const repo = activeRepoName();
  const inst = manager.get(repo);
  if (!inst) {
    await push(chatId, "⚠️ No active repo — use /repo first.");
    return;
  }
  const sid = await activeSession(repo);
  const view = new TurnView(bot, chatId);
  turnViews.set(turnKey(repo, sid), view);
  await view.ensureActivity();
  try {
    await inst.promptAsync(sid, parts, {
      agent: opts.agent || state.get().activeAgents[repo],
      model: opts.model || state.get().activeModels[repo]
    });
  } catch (e) {
    await view.finalize("");
    turnViews.delete(turnKey(repo, sid));
    await push(chatId, `⚠️ Could not send: <code>${esc(e.message)}</code>\nSession may be busy — /abort to stop it. If it asked you something, answer the question buttons or /pending.`);
    return;
  }
  expectingTurn.add(turnKey(repo, sid));
}

async function onPermissionAsked(repo, p) {
  if (pendingAsks.has(p.id)) return;
  console.log(`[ask] permission registered: ${p.id} repo=${repo} tool=${p.permission}`);
  const what = p.metadata?.command || (p.patterns || []).join(", ") || p.permission;
  const repoTag = Object.keys(state.get().repos).length > 1 ? `[${repo}] ` : "";
  const html = `${repoTag}🔐 <b>Permission needed</b>\ntool: <code>${esc(p.permission)}</code>\n<code>${esc(what)}</code>`;
  const kb = new InlineKeyboard()
    .text("✅ Once", `p|${p.id}|once`)
    .text("🔁 Always", `p|${p.id}|always`)
    .text("❌ Deny", `p|${p.id}|reject`);
  const msgs = await push(ownerChat(), html, { reply_markup: kb });
  pendingAsks.set(p.id, { kind: "permission", reqId: p.id, repo, chatId: ownerChat(), messageIds: msgs.map((m) => m.message_id) });
}

function questionText(q) {
  let t = `❓ <b>${esc(q.header || "Question")}</b>\n${esc(q.question)}`;
  if (q.multiple) t += "\n\n<i>Select all that apply.</i>";
  t += "\n\n<i>Tap an option — or just type your answer.</i>";
  return t;
}

async function onQuestionAsked(repo, p) {
  if (pendingAsks.has(p.id)) return;
  console.log(`[ask] question registered: ${p.id} repo=${repo}`);
  const ask = {
    kind: "question",
    reqId: p.id,
    repo,
    chatId: ownerChat(),
    questions: p.questions,
    answers: p.questions.map(() => null),
    messageIds: []
  };
  pendingAsks.set(p.id, ask);
  for (let qi = 0; qi < p.questions.length; qi++) {
    const q = p.questions[qi];
    const kb = new InlineKeyboard();
    for (let oi = 0; oi < Math.min(q.options.length, 8); oi++) {
      kb.text(q.options[oi].label.slice(0, 60), `q|${p.id}|${qi}|${oi}`);
      if (oi % 2 === 1) kb.row();
    }
    kb.row().text("🚫 Skip", `qrej|${p.id}`);
    const msgs = await push(ask.chatId, questionText(q), { reply_markup: kb });
    ask.messageIds.push(...msgs.map((m) => m.message_id));
  }
}

async function onMessageUpdated(repo, { sessionID, info }) {
  if (info.role !== "assistant") return;
  if (!info.time?.completed) return;
  if (sentMessages.has(info.id)) return;
  sentMessages.add(info.id);
  if (sentMessages.size > 500) sentMessages.clear();
  const chatId = ownerChat();
  const key = turnKey(repo, sessionID);
  try {
    const full = await manager.get(repo).getMessage(sessionID, info.id);
    if (info.error) {
      const msg = typeof info.error === "string" ? info.error : JSON.stringify(info.error);
      await push(chatId, `❌ <b>Error</b>\n${esc(msg.slice(0, 800))}`);
      expectingTurn.delete(key);
      return;
    }
    const text = (full.parts || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    const view = turnViews.get(key);
    if (view) {
      view.sentText = Boolean(text.trim());
      await view.finalize(text);
    } else if (text.trim()) {
      await push(chatId, mdToHtml(text));
    }
    expectingTurn.delete(key);
  } catch (e) {
    console.error("[ev] message fetch failed:", e.message);
  }
}

const QUIET_TOOLS = new Set(["read", "glob", "grep", "question", "todowrite", "todoread"]);

function toolLine(part) {
  const i = part.state?.input || {};
  const arg = i.command || i.description || i.url || i.query || i.pattern || i.filePath || i.file_path || "";
  return `${part.tool}${arg ? " — " + String(arg).slice(0, 100) : ""}`;
}

async function onPartUpdated(repo, { part }) {
  const view0 = turnViews.get(`${repo}|${part.sessionID}`);
  if (view0 && !view0.closed) view0.notePart(part);
  if (part.type !== "tool" || QUIET_TOOLS.has(part.tool)) return;
  const view = turnViews.get(`${repo}|${part.sessionID}`);
  const st = part.state?.status;
  if (st === "running") {
    if (toolSeen.has(part.id)) return;
    toolSeen.add(part.id);
    if (toolSeen.size > 1000) toolSeen.clear();
    view?.addTool(toolLine(part));
  } else if (st === "error") {
    const errTxt = part.state?.error || "failed";
    view?.addTool(`${part.tool} ⚠️ ${String(errTxt).slice(0, 80)}`);
  }
}

async function onDelta(repo, d) {
  if (d.field !== "text") return;
  const view = turnViews.get(turnKey(repo, d.sessionID));
  view?.addDelta(d.partID, d.field, d.delta);
}

async function onSessionStatus(repo, { sessionID, status }) {
  if (status.type !== "retry") {
    retryNotified.delete(`${repo}|${sessionID}`);
    return;
  }
  const key = `${repo}|${sessionID}`;
  if (retryNotified.has(key)) return;
  retryNotified.add(key);
  await push(ownerChat(), `⚠️ [${repo}] Provider retry (attempt ${status.attempt}): ${esc((status.message || "").slice(0, 200))}`);
}

async function onSessionIdle(repo, sessionID) {
  const key = turnKey(repo, sessionID);
  const view = turnViews.get(key);
  if (view) {
    if (!view.closed) await view.finalize("");
    turnViews.delete(key);
  }
  if (expectingTurn.has(key)) {
    expectingTurn.delete(key);
    await push(ownerChat(), "✅ Finished (no text output).");
  }
}

function handleEvent(repo) {
  return async (ev) => {
    try {
      switch (ev.type) {
        case "permission.asked":
          return await onPermissionAsked(repo, ev.properties);
        case "permission.replied": {
          const id = ev.properties.requestID;
          if (pendingAsks.has(id)) {
            console.log(`[ask] permission ${id} answered elsewhere — cleaning up`);
            pendingAsks.delete(id);
          }
          return;
        }
        case "question.asked":
          return await onQuestionAsked(repo, ev.properties);
        case "question.replied":
        case "question.rejected": {
          const id = ev.properties.requestID;
          if (pendingAsks.has(id)) {
            console.log(`[ask] question ${id} answered elsewhere (${ev.type}) — cleaning up`);
            pendingAsks.delete(id);
          }
          return;
        }
        case "message.updated":
          return await onMessageUpdated(repo, ev.properties);
        case "message.part.updated":
          return await onPartUpdated(repo, ev.properties);
        case "message.part.delta":
          return await onDelta(repo, ev.properties);
        case "session.status":
          return await onSessionStatus(repo, ev.properties);
        case "session.idle":
          return await onSessionIdle(repo, ev.properties.sessionID);
      }
    } catch (e) {
      console.error(`[ev:${repo}] ${ev.type} handler failed:`, e.message);
    }
  };
}

function startReconcile() {
  setInterval(async () => {
    try {
      const serverIds = new Set();
      for (const [, inst] of manager.instances) {
        try {
          for (const p of await inst.pendingPermissions()) serverIds.add(p.id);
          for (const q of await inst.pendingQuestions()) serverIds.add(q.id);
        } catch {}
      }
      for (const id of [...pendingAsks.keys()]) {
        if (!serverIds.has(id)) {
          console.log(`[ask] reconcile: dropping stale ${id}`);
          pendingAsks.delete(id);
        }
      }
    } catch {}
  }, 60000).unref();
}

async function announcePending() {
  for (const [name, inst] of manager.instances) {
    try {
      const perms = await inst.pendingPermissions();
      for (const p of perms) await onPermissionAsked(name, p);
      const questions = await inst.pendingQuestions();
      for (const q of questions) await onQuestionAsked(name, q);
    } catch {}
  }
}

const POLICY = {
  $schema: "https://opencode.ai/config.json",
  permission: {
    bash: {
      "*": "ask",
      "git status*": "allow",
      "git log*": "allow",
      "git diff*": "allow",
      "ls*": "allow",
      "dir*": "allow",
      "cat *": "allow",
      "echo *": "allow",
      pwd: "allow",
      "node *": "allow",
      "npm *": "allow"
    },
    webfetch: "allow",
    websearch: "allow",
    edit: "allow"
  }
};

async function rebuildAskFromServer(reqId) {
  for (const [name, inst] of manager.instances) {
    try {
      const q = (await inst.pendingQuestions()).find((x) => x.id === reqId);
      if (q) {
        const ask = {
          kind: "question",
          reqId: q.id,
          repo: name,
          chatId: ownerChat(),
          questions: q.questions,
          answers: q.questions.map(() => null),
          messageIds: []
        };
        pendingAsks.set(reqId, ask);
        console.log(`[ask] rebuilt from server: ${reqId}`);
        return ask;
      }
    } catch {}
  }
  return null;
}

async function serverPendingCount() {
  let n = 0;
  for (const [, inst] of manager.instances) {
    try {
      n += (await inst.pendingQuestions()).length;
    } catch {}
  }
  return n;
}

async function findFirstServerQuestion() {
  for (const [name, inst] of manager.instances) {
    try {
      const qs = await inst.pendingQuestions();
      if (qs.length) return qs[0].id;
    } catch {}
  }
  return null;
}

async function submitAnswers(ask) {
  const payload = ask.answers.map((a) => (Array.isArray(a) ? a : [a]));
  await manager.get(ask.repo).replyQuestion(ask.reqId, payload);
  pendingAsks.delete(ask.reqId);
  console.log(`[ask] submitted answers for ${ask.reqId}: ${JSON.stringify(payload)}`);
}

function ownerOnly() {
  return async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid === undefined || String(uid) !== OWNER) return;
    if (ctx.chat && state.get().chatId !== ctx.chat.id) state.set({ chatId: ctx.chat.id });
    console.log(`[tg] update: ${ctx.updateType}${ctx.callbackQuery ? " " + (ctx.callbackQuery.data || "") : ctx.message?.text ? ` "${ctx.message.text.slice(0, 50)}"` : ""}`);
    await next();
  };
}

async function sessionsList(chatId) {
  const repo = activeRepoName();
  const inst = manager.get(repo);
  const sessions = (await inst.listSessions())
    .filter((s) => !s.parentID)
    .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
    .slice(0, 15);
  state.set({ lastSessionLists: { ...state.get().lastSessionLists, [repo]: sessions.map((s) => s.id) } });
  const active = state.get().activeSessions[repo];
  const lines = sessions.map(
    (s, i) => `${s.id === active ? "▶️" : `<b>${i + 1}.</b>`} ${esc((s.title || "untitled").slice(0, 60))}\n      <i>${esc(s.id)}</i>`
  );
  if (!sessions.length) {
    await push(chatId, `<b>repo: ${esc(repo)}</b>\n\nما في جلسات بعد — ابعت رسالة أو /new`);
    return;
  }
  const kb = new InlineKeyboard();
  sessions.forEach((s, i) => {
    kb.text(`${s.id === active ? "▶️" : ""}${i + 1}`, `sw|${i}`);
    if (i % 5 === 4) kb.row();
  });
  await push(chatId, `<b>repo: ${esc(repo)}</b>\n\n${lines.join("\n")}\n\n<i>اكبس الرقم للتبديل:</i>`, { reply_markup: kb });
}

async function modelsList(inst, query) {
  const cfg = await inst.api("GET", "/config/providers");
  const entries = [];
  for (const p of cfg.providers || []) {
    const models = p.models || {};
    const keys = Array.isArray(models) ? models.map((m) => m.id || m) : Object.keys(models);
    for (const m of keys) entries.push(`${p.id}/${m}`);
  }
  const q = (query || "").toLowerCase();
  const filtered = q ? entries.filter((e) => e.toLowerCase().includes(q)) : entries;
  return filtered.slice(0, 40);
}

function registerCommands() {
  const helpText = [
    "<b>TeleCode</b> — opencode on Telegram",
    "",
    "Type any message → prompt to the active session (streamed live).",
    "Photos/documents + caption → sent to the session.",
    "Approvals and questions arrive here as buttons.",
    "",
    "/new — fresh session (asks what to do) · /new &lt;title&gt;",
    "/sessions — list + tap to switch · /switch &lt;n&gt;",
    "/abort — stop current task · /cancel — drop a pending prompt",
    "/repo — list · /repo &lt;name&gt; — switch",
    "/repo add &lt;name&gt; &lt;path&gt; — add a repo",
    "/repo remove &lt;name&gt;",
    "/model [provider/model | list &lt;q&gt;]",
    "/agent [name] · /mode — plan/build toggle",
    "/diff · /todos · /cost · /share · /revert",
    "/pending — un-answered approvals · /status"
  ].join("\n");

  bot.command("start", (ctx) => push(ctx.chat.id, helpText));
  bot.command("help", (ctx) => push(ctx.chat.id, helpText));

  bot.command("new", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) {
      pendingInput.set(ctx.chat.id, { type: "new_session" });
      await push(
        ctx.chat.id,
        "🆕 <b>جلسة جديدة</b>\nاكتب شو بدك تعمل (أو اسم للجلسة) ومنبلّش فوراً 👇\n\n<i>/cancel للإلغاء.</i>"
      );
      return;
    }
    await startNewSession(ctx.chat.id, arg);
  });

  bot.command("cancel", async (ctx) => {
    if (pendingInput.delete(ctx.chat.id)) await push(ctx.chat.id, "✖️ تم الإلغاء.");
    else await push(ctx.chat.id, "ما في شي معلّق لإلغائه.");
  });

  bot.command("sessions", async (ctx) => sessionsList(ctx.chat.id));

  bot.command("switch", async (ctx) => {
    const repo = activeRepoName();
    const n = parseInt((ctx.match || "").trim(), 10);
    const list = state.get().lastSessionLists[repo] || [];
    if (!n || n < 1 || n > list.length) {
      await push(ctx.chat.id, "Usage: /switch &lt;n&gt; — run /sessions first.");
      return;
    }
    const sid = list[n - 1];
    state.set({ activeSessions: { ...state.get().activeSessions, [repo]: sid } });
    await push(ctx.chat.id, `🔄 [${esc(repo)}] Switched to <code>${esc(sid)}</code>`);
  });

  bot.command("abort", async (ctx) => {
    const repo = activeRepoName();
    const sid = state.get().activeSessions[repo];
    if (!sid) {
      await push(ctx.chat.id, "No active session.");
      return;
    }
    try {
      await manager.get(repo).abortSession(sid);
      const key = turnKey(repo, sid);
      expectingTurn.delete(key);
      const view = turnViews.get(key);
      if (view && !view.closed) await view.finalize("");
      await push(ctx.chat.id, "🛑 Abort sent.");
    } catch (e) {
      await push(ctx.chat.id, `⚠️ Abort failed: ${esc(e.message)}`);
    }
  });

  bot.command("repo", async (ctx) => {
    const arg = (ctx.match || "").trim();
    const repos = state.get().repos;
    if (!arg) {
      const lines = Object.entries(repos).map(([name, r]) =>
        `${name === state.get().activeRepo ? "▶️" : "•"} <b>${esc(name)}</b> — <code>${esc(r.dir)}</code> :${r.port}`
      );
      await push(ctx.chat.id, `<b>Repos</b>\n${lines.join("\n") || "none"}\n\n/repo add &lt;name&gt; &lt;path&gt;`);
      return;
    }
    if (arg.startsWith("add ")) {
      const rest = arg.slice(4).trim();
      const sp = rest.indexOf(" ");
      if (sp < 0) {
        await push(ctx.chat.id, "Usage: /repo add &lt;name&gt; &lt;path&gt;");
        return;
      }
      const name = rest.slice(0, sp).toLowerCase().replace(/[^a-z0-9-]/g, "");
      const dir = rest.slice(sp + 1).trim();
      if (!name || !dir) {
        await push(ctx.chat.id, "Usage: /repo add &lt;name&gt; &lt;path&gt;");
        return;
      }
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        await push(ctx.chat.id, `⚠️ Not a directory: <code>${esc(dir)}</code>`);
        return;
      }
      if (repos[name]) {
        await push(ctx.chat.id, `⚠️ Repo <b>${esc(name)}</b> exists — /repo remove ${esc(name)} first.`);
        return;
      }
      const port = manager.allocPort();
      const cfgPath = path.join(dir, "opencode.json");
      let policyNote = "";
      if (!fs.existsSync(cfgPath)) {
        fs.writeFileSync(cfgPath, JSON.stringify(POLICY, null, 2));
        policyNote = " (bash-ask policy written)";
      }
      manager.register(name, dir, port);
      state.set({
        repos: { ...repos, [name]: { dir, port } },
        activeRepo: name
      });
      try {
        await manager.get(name).ensure();
      } catch (e) {
        await push(ctx.chat.id, `⚠️ Repo added but server failed: ${esc(e.message)}`);
        return;
      }
      manager.get(name).watchEvents(handleEvent(name));
      await push(ctx.chat.id, `📁 Repo <b>${esc(name)}</b> added &amp; active${esc(policyNote)}\n<code>${esc(dir)}</code> :${port}`);
      return;
    }
    if (arg.startsWith("remove ")) {
      const name = arg.slice(7).trim();
      if (!repos[name]) {
        await push(ctx.chat.id, "No such repo.");
        return;
      }
      if (name === state.get().activeRepo) {
        await push(ctx.chat.id, "Switch away first — it is the active repo.");
        return;
      }
      const reposNext = { ...repos };
      delete reposNext[name];
      const inst = manager.get(name);
      try {
        inst?.child?.kill();
      } catch {}
      state.set({ repos: reposNext });
      await push(ctx.chat.id, `🗑 Repo <b>${esc(name)}</b> removed (its server may keep running).`);
      return;
    }
    const name = arg.toLowerCase();
    if (!repos[name]) {
      await push(ctx.chat.id, "No such repo — /repo to list, /repo add to add.");
      return;
    }
    state.set({ activeRepo: name });
    await push(ctx.chat.id, `▶️ Active repo: <b>${esc(name)}</b>\n<code>${esc(repos[name].dir)}</code> :${repos[name].port}`);
  });

  bot.command("model", async (ctx) => {
    const repo = activeRepoName();
    const inst = manager.get(repo);
    const arg = (ctx.match || "").trim();
    if (!arg) {
      const cur = state.get().activeModels[repo] || "(provider default)";
      await push(ctx.chat.id, `🧠 [${esc(repo)}] model: <b>${esc(cur)}</b>\n/model list [query] — browse\n/model provider/model — set\n/model clear — reset`);
      return;
    }
    if (arg === "clear") {
      state.set({ activeModels: { ...state.get().activeModels, [repo]: undefined } });
      await push(ctx.chat.id, "🧠 Model override cleared.");
      return;
    }
    if (arg.startsWith("list")) {
      const query = arg.slice(4).trim();
      const entries = await modelsList(inst, query);
      await push(ctx.chat.id, `<b>Models${query ? ` matching "${esc(query)}"` : ""} (first 40)</b>\n${entries.map((e) => `• <code>${esc(e)}</code>`).join("\n") || "none"}`);
      return;
    }
    if (!arg.includes("/")) {
      await push(ctx.chat.id, "Format: <code>providerID/modelID</code>");
      return;
    }
    const entries = await modelsList(inst, "");
    if (!entries.includes(arg)) {
      await push(ctx.chat.id, `⚠️ Unknown model <code>${esc(arg)}</code> — /model list ${esc(arg.split("/")[0])}`);
      return;
    }
    state.set({ activeModels: { ...state.get().activeModels, [repo]: arg } });
    await push(ctx.chat.id, `🧠 [${esc(repo)}] Model set: <b>${esc(arg)}</b>`);
  });

  bot.command("mode", async (ctx) => {
    const repo = activeRepoName();
    let names = ["build", "plan"];
    try {
      const agents = await manager.get(repo).api("GET", "/agent");
      const top = agents.filter((a) => a.mode !== "subagent").map((a) => a.name);
      if (top.length) names = top;
    } catch {}
    const cur = state.get().activeAgents[repo] || names[0] || "build";
    const kb = new InlineKeyboard();
    for (const n of names.slice(0, 8)) kb.text(n === cur ? `● ${n} (current)` : n, `m|${n}`).row();
    await push(ctx.chat.id, `🎛 [${esc(repo)}] agent: <b>${esc(cur)}</b>\n${cur === "plan" ? "Plane mode: read-only, no edits." : "Build mode: full edit + run powers."}\nTap to switch:`, { reply_markup: kb });
  });

  bot.command("agent", async (ctx) => {
    const repo = activeRepoName();
    const inst = manager.get(repo);
    const arg = (ctx.match || "").trim();
    const agents = await inst.api("GET", "/agent");
    if (!arg) {
      await push(
        ctx.chat.id,
        `<b>Agents [${esc(repo)}]</b>\n${agents.map((a) => `${a.mode === "subagent" ? "▫️" : "•"} <code>${esc(a.name)}</code> <i>${esc(a.mode || "")}</i>`).join("\n")}\n\n/agent &lt;name&gt; — set`
      );
      return;
    }
    const found = agents.find((a) => a.name === arg);
    if (!found) {
      await push(ctx.chat.id, `⚠️ No agent named <code>${esc(arg)}</code>`);
      return;
    }
    state.set({ activeAgents: { ...state.get().activeAgents, [repo]: arg } });
    await push(ctx.chat.id, `🤖 [${esc(repo)}] Agent set: <b>${esc(arg)}</b>`);
  });

  bot.command("diff", async (ctx) => {
    const repo = activeRepoName();
    const sid = state.get().activeSessions[repo];
    if (!sid) return push(ctx.chat.id, "No active session.");
    const diffs = await manager.get(repo).sessionDiff(sid);
    await push(ctx.chat.id, `<b>[${esc(repo)}] Diff</b>\n${fmtDiff(diffs)}`);
  });

  bot.command("todos", async (ctx) => {
    const repo = activeRepoName();
    const sid = state.get().activeSessions[repo];
    if (!sid) return push(ctx.chat.id, "No active session.");
    const todos = await manager.get(repo).sessionTodo(sid);
    await push(ctx.chat.id, `<b>[${esc(repo)}] Todos</b>\n${fmtTodos(todos)}`);
  });

  bot.command("cost", async (ctx) => {
    const repo = activeRepoName();
    const sid = state.get().activeSessions[repo];
    if (!sid) return push(ctx.chat.id, "No active session.");
    const s = await manager.get(repo).sessionDetail(sid);
    await push(ctx.chat.id, `<b>[${esc(repo)}]</b> ${esc((s.title || "").slice(0, 50))}\n${fmtCost(s)}`);
  });

  bot.command("share", async (ctx) => {
    const repo = activeRepoName();
    const sid = state.get().activeSessions[repo];
    if (!sid) return push(ctx.chat.id, "No active session.");
    const s = await manager.get(repo).shareSession(sid);
    const url = s?.share?.url;
    await push(ctx.chat.id, url ? `🔗 ${esc(url)}` : "⚠️ Sharing not available.");
  });

  bot.command("revert", async (ctx) => {
    const repo = activeRepoName();
    const sid = state.get().activeSessions[repo];
    if (!sid) return push(ctx.chat.id, "No active session.");
    const inst = manager.get(repo);
    const msgs = await inst.api("GET", `/session/${sid}/message`);
    const lastUser = [...msgs].reverse().find((m) => m.info.role === "user");
    if (!lastUser) return push(ctx.chat.id, "Nothing to revert.");
    await inst.revertSession(sid, lastUser.info.id);
    await push(ctx.chat.id, "⏪ Reverted last turn.");
  });

  bot.command("status", async (ctx) => {
    const repo = activeRepoName();
    const sid = state.get().activeSessions[repo];
    let statusLine = "no active session";
    let title = "-";
    if (sid) {
      try {
        const sts = await manager.get(repo).sessionStatuses();
        const st = sts[sid];
        statusLine = st ? st.type : "idle";
        const s = (await manager.get(repo).listSessions()).find((x) => x.id === sid);
        title = s?.title || "-";
      } catch {}
    }
    let version = "?";
    try {
      version = (await manager.get(repo).api("GET", "/global/health")).version;
    } catch {}
    await push(
      ctx.chat.id,
      `🟢 TeleCode bridge\nopencode: <code>${esc(version)}</code>\nrepo: <b>${esc(repo)}</b>\nsession: ${esc(title)}\n<code>${esc(sid || "-")}</code>\nstatus: <b>${esc(statusLine)}</b>\nmodel: <b>${esc(state.get().activeModels[repo] || "default")}</b>\nagent: <b>${esc(state.get().activeAgents[repo] || "default")}</b>\npending asks: ${pendingAsks.size}`
    );
  });

  bot.command("pending", async (ctx) => {
    await announcePending();
    if (pendingAsks.size === 0) await push(ctx.chat.id, "Nothing pending.");
  });
}

function registerCallbacks() {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    try {
      if (data.startsWith("p|")) {
        const [, reqId, choice] = data.split("|");
        console.log(`[cb] permission answer: ${data}`);
        const ask = pendingAsks.get(reqId);
        await manager.get(ask?.repo || activeRepoName()).replyPermission(reqId, choice);
        pendingAsks.delete(reqId);
        console.log(`[ask] permission ${choice} submitted for ${reqId}`);
        const label = choice === "once" ? "approved (once)" : choice === "always" ? "approved (always)" : "denied";
        await ctx.editMessageText(`${choice === "reject" ? "❌" : "✅"} Permission ${label}.`).catch(() => {});
        await ctx.answerCallbackQuery({ text: `Permission ${choice}` });
      } else if (data.startsWith("m|")) {
        const [, name] = data.split("|");
        console.log(`[cb] mode switch: ${data}`);
        const repo = activeRepoName();
        state.set({ activeAgents: { ...state.get().activeAgents, [repo]: name } });
        await ctx.editMessageText(`🎛 [${esc(repo)}] agent switched to <b>${esc(name)}</b>${name === "plan" ? " (read-only)" : ""}`).catch(() => {});
        await ctx.answerCallbackQuery({ text: `Agent: ${name}` });
      } else if (data.startsWith("sw|")) {
        const [, idx] = data.split("|");
        console.log(`[cb] session switch: ${data}`);
        const repo = activeRepoName();
        const list = state.get().lastSessionLists[repo] || [];
        const sid = list[Number(idx)];
        if (!sid) {
          await ctx.answerCallbackQuery({ text: "الجلسة ما عادت موجودة — /sessions" });
          return;
        }
        state.set({ activeSessions: { ...state.get().activeSessions, [repo]: sid } });
        await ctx.editMessageText(`🔄 [${esc(repo)}] تم التبديل للجلسة #${Number(idx) + 1}\n<code>${esc(sid)}</code>`, { parse_mode: "HTML" }).catch(() => {});
        await ctx.answerCallbackQuery({ text: "تم التبديل ✅" });
      } else if (data.startsWith("q|")) {
        const [, reqId, qi, oi] = data.split("|");
        console.log(`[cb] question answer: ${data}`);
        let ask = pendingAsks.get(reqId);
        if (!ask) ask = await rebuildAskFromServer(reqId);
        if (!ask) {
          await ctx.answerCallbackQuery({ text: "Question no longer pending" });
          return;
        }
        const q = ask.questions[Number(qi)];
        const label = q?.options?.[Number(oi)]?.label ?? `option ${oi}`;
        ask.answers[Number(qi)] = label;
        await ctx.editMessageText(`✔️ ${esc(label)}`).catch(() => {});
        if (ask.answers.every((a) => a !== null)) {
          await submitAnswers(ask);
          await ctx.answerCallbackQuery({ text: "Answer sent" });
        } else {
          const done = ask.answers.filter((a) => a !== null).length;
          await ctx.answerCallbackQuery({ text: `Saved (${done}/${ask.answers.length})` });
        }
      } else if (data.startsWith("qrej|")) {
        const [, reqId] = data.split("|");
        console.log(`[cb] question skip: ${data}`);
        const ask = pendingAsks.get(reqId);
        pendingAsks.delete(reqId);
        await manager.get(ask?.repo || activeRepoName()).rejectQuestion(reqId).catch(() => {});
        await ctx.editMessageText("🚫 Question skipped.").catch(() => {});
        await ctx.answerCallbackQuery({ text: "Skipped" });
      } else {
        console.log(`[cb] unknown: ${data}`);
        await ctx.answerCallbackQuery();
      }
    } catch (e) {
      console.error("[cb] failed:", e.message);
      await ctx.answerCallbackQuery({ text: "Failed — try again" }).catch(() => {});
    }
  });
}

function registerMessages() {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    const chatId = ctx.chat.id;

    const pend = pendingInput.get(chatId);
    if (pend) {
      pendingInput.delete(chatId);
      if (pend.type === "new_session") {
        await startNewSession(chatId, text, { runAsPrompt: true });
        return;
      }
    }

    const openQuestion = [...pendingAsks.values()].find(
      (a) => a.kind === "question" && a.chatId === chatId && a.answers.some((x) => x === null)
    );
    let target = openQuestion;
    if (!target) {
      const count = await serverPendingCount();
      if (count === 1) {
        const rid = await findFirstServerQuestion();
        if (rid) target = await rebuildAskFromServer(rid);
      } else if (count > 1) {
        await announcePending();
        await push(chatId, "❓ Multiple pending questions — answer them via the buttons above first.");
        return;
      }
    }
    if (target) {
      const ask = target;
      const qi = ask.answers.findIndex((x) => x === null);
      ask.answers[qi] = text;
      if (ask.answers.every((x) => x !== null)) {
        try {
          await submitAnswers(ask);
          await push(chatId, `📩 Answer sent: <b>${esc(text.slice(0, 100))}</b>`);
        } catch (e) {
          await push(chatId, `⚠️ Could not submit answer: ${esc(e.message)}`);
        }
      } else {
        const done = ask.answers.filter((x) => x !== null).length;
        await push(chatId, `📩 Saved (${done}/${ask.answers.length}) — tap an option or type for the rest.`);
      }
      return;
    }

    await sendPrompt(chatId, [{ type: "text", text }]);
  });
}

async function handleIncomingFile(ctx, fileId, mime, name, caption) {
  const chatId = ctx.chat.id;
  try {
    const { buffer } = await media.downloadTelegramFile(TOKEN, fileId);
    if (buffer.length > media.MAX_BYTES) {
      await push(chatId, "⚠️ File too large (10MB limit).");
      return;
    }
    const kb = `${(buffer.length / 1024).toFixed(0)} KB`;
    if (mime.startsWith("image/")) {
      await sendPrompt(chatId, [
        { type: "file", mime, filename: name, url: media.toDataUri(buffer, mime) },
        { type: "text", text: caption || "User sent this image without a caption — look at it and respond." }
      ]);
      await push(chatId, `📎 <b>${esc(name)}</b> (${kb}) sent`);
    } else {
      const repo = activeRepoName();
      const saved = media.saveToWorkspace(manager.get(repo).dir, name, buffer);
      await sendPrompt(chatId, [
        { type: "text", text: `${caption ? caption + "\n\n" : ""}A file was saved to: ${saved}` }
      ]);
      await push(chatId, `📎 <b>${esc(name)}</b> (${kb}) saved to <code>${esc(saved)}</code>`);
    }
  } catch (e) {
    await push(chatId, `⚠️ File handling failed: ${esc(e.message)}`);
  }
}

function registerMedia() {
  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    await handleIncomingFile(ctx, best.file_id, "image/jpeg", `photo-${Date.now()}.jpg`, ctx.message.caption);
  });

  bot.on("message:document", async (ctx) => {
    const d = ctx.message.document;
    await handleIncomingFile(ctx, d.file_id, d.mime_type || "application/octet-stream", d.file_name || `file-${Date.now()}`, ctx.message.caption);
  });

  bot.on("message:voice", async (ctx) => {
    await push(ctx.chat.id, "🎙 Voice not configured yet — add STT_API_KEY to .env to enable it.");
  });

  bot.on("message:audio", async (ctx) => {
    await push(ctx.chat.id, "🎙 Audio not configured yet — add STT_API_KEY to .env to enable it.");
  });
}

async function main() {
  state.load();

  manager = new ServerManager(PASSWORD);
  for (const [name, r] of Object.entries(state.get().repos)) {
    manager.register(name, r.dir, r.port);
  }
  await manager.ensureAll();
  manager.startWatchdog();
  startReconcile();
  for (const [name, inst] of manager.instances) {
    console.log(`[bridge] opencode[${name}] ${inst.adopted ? "adopted" : "spawned"} at ${inst.base} (${inst.dir})`);
    inst.watchEvents(handleEvent(name));
  }

  bot = new Bot(TOKEN);
  bot.catch((err) => console.error("[tg] bot error:", err.error?.message || err.message));
  bot.use(ownerOnly());
  registerCommands();
  registerCallbacks();
  registerMessages();
  registerMedia();

  await bot.init();
  await bot.api.setMyCommands([
    { command: "new", description: "New session — asks what to do" },
    { command: "sessions", description: "List sessions (tap to switch)" },
    { command: "switch", description: "Switch to session n" },
    { command: "abort", description: "Stop the current task" },
    { command: "cancel", description: "Cancel a pending prompt" },
    { command: "repo", description: "List / switch / add repos" },
    { command: "model", description: "Show or set the model" },
    { command: "mode", description: "Switch plan / build mode" },
    { command: "agent", description: "Show or set the agent" },
    { command: "diff", description: "Session file changes" },
    { command: "todos", description: "Session todo list" },
    { command: "cost", description: "Session tokens and cost" },
    { command: "share", description: "Get share URL" },
    { command: "revert", description: "Undo last turn" },
    { command: "pending", description: "Pending approvals/questions" },
    { command: "status", description: "Bridge status" },
    { command: "help", description: "How to use" }
  ]);

  await push(
    ownerChat(),
    `✅ TeleCode v2 is running.\nrepo: <b>${esc(activeRepoName())}</b> · streaming on · ${manager.instances.size} server${manager.instances.size === 1 ? "" : "s"}\n\nNew: /repo /model /agent /diff /todos /cost /share /revert — photos work too. /help for all.`
  );
  await announcePending();

  await bot.start({ onStart: () => console.log("[bridge] telegram polling started") });
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
