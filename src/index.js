require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Bot, InlineKeyboard, InputFile } = require("grammy");
const { ServerManager } = require("./oc");
const state = require("./state");
const { mdToHtml, splitHtml, esc, fmtDiff, fmtTodos, fmtCost } = require("./format");
const { TurnView, editSafe } = require("./stream");
const media = require("./media");
const stt = require("./stt");
const git = require("./git");
const files = require("./files");

const OWNER_ENV = String(process.env.TELEGRAM_OWNER_ID || "");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";
if (!TOKEN) {
  console.error("[bridge] TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}
// Owner id comes from the persisted state (set by auto-pairing) or from the
// env var. If neither is set the bridge runs in PAIRING mode: the first person
// who messages the bot becomes the owner and gets locked in.
const currentOwner = () => String(state.get().ownerId || OWNER_ENV || "");

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

const ownerChat = () => state.get().chatId || Number(currentOwner()) || 0;
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

async function sendDoc(chatId, filename, content, caption) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  try {
    await bot.api.sendDocument(chatId, new InputFile(buf, filename), caption ? { caption } : {});
  } catch (e) {
    await push(chatId, `⚠️ Could not send file: <code>${esc(e.message)}</code>`);
  }
}

function repoDir(repo) {
  return state.get().repos[repo]?.dir;
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
    await push(chatId, "⚠️ No active repo — use /repo first.");
    return null;
  }
  const title = (text && text.trim() ? text.trim() : `tg ${new Date().toISOString().slice(0, 16)}`).slice(0, 80);
  let s;
  try {
    s = await inst.createSession(title);
  } catch (e) {
    await push(chatId, `⚠️ Could not create a session: <code>${esc(e.message)}</code>`);
    return null;
  }
  state.set({ activeSessions: { ...state.get().activeSessions, [repo]: s.id } });
  await push(chatId, `🆕 [${esc(repo)}] New session: <b>${esc(title)}</b>\n<code>${esc(s.id)}</code>`);
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
  startTyping(chatId);
}

async function onPermissionAsked(repo, p) {
  if (pendingAsks.has(p.id)) return;
  if (state.get().yolo[repo]) {
    console.log(`[ask] YOLO auto-approve ${p.id} repo=${repo} tool=${p.permission}`);
    try {
      await manager.get(repo).replyPermission(p.id, "always");
      return;
    } catch (e) {
      console.error("[ask] YOLO approve failed:", e.message);
    }
  }
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
  stopTyping(ownerChat());
  await maybeBudgetAlert(repo, sessionID);
  await offerTurnControls(ownerChat());
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
    if (uid === undefined) return;
    const owner = currentOwner();
    if (!owner) {
      // Pairing mode: claim ownership for the first user who messages us.
      state.set({ ownerId: uid, chatId: ctx.chat?.id ?? null });
      console.log(`[tg] paired with owner ${uid}`);
      await push(
        ctx.chat.id,
        "✅ <b>Paired!</b> You're now the owner of this bridge.\nNobody else can use it.\n\nTap a button below to get going 👇"
      );
      await sendMenu(ctx.chat.id);
      return; // don't treat this first message as a prompt
    }
    const isOwner = String(uid) === owner;
    const isTeam = state.get().allowedUsers.map(String).includes(String(uid));
    if (!isOwner && !isTeam) return;
    if (isOwner && ctx.chat && state.get().chatId !== ctx.chat.id) state.set({ chatId: ctx.chat.id });
    console.log(`[tg] update: ${ctx.updateType}${ctx.callbackQuery ? " " + (ctx.callbackQuery.data || "") : ctx.message?.text ? ` "${ctx.message.text.slice(0, 50)}"` : ""}`);
    await next();
  };
}

async function sessionsView() {
  const repo = activeRepoName();
  const inst = manager.get(repo);
  const sessions = (await inst.listSessions())
    .filter((s) => !s.parentID)
    .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
    .slice(0, 15);
  state.set({ lastSessionLists: { ...state.get().lastSessionLists, [repo]: sessions.map((s) => s.id) } });
  const active = state.get().activeSessions[repo];
  const kb = new InlineKeyboard();
  if (!sessions.length) {
    kb.text("⬅️ Menu", "mn|home");
    return { html: `<b>repo: ${esc(repo)}</b>\n\nNo sessions yet — send a message or /new`, kb };
  }
  const lines = sessions.map(
    (s, i) => `${s.id === active ? "▶️" : `<b>${i + 1}.</b>`} ${esc((s.title || "untitled").slice(0, 60))}\n      <i>${esc(s.id)}</i>`
  );
  sessions.forEach((s, i) => {
    kb.text(`${s.id === active ? "▶️" : ""}${i + 1}`, `sw|${i}`);
    if (i % 5 === 4) kb.row();
  });
  kb.row().text("⬅️ Menu", "mn|home");
  return { html: `<b>repo: ${esc(repo)}</b>\n\n${lines.join("\n")}\n\n<i>Tap a number to switch:</i>`, kb };
}

async function sessionsList(chatId) {
  const v = await sessionsView();
  await push(chatId, v.html, { reply_markup: v.kb });
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

const HELP_TEXT = [
  "<b>TeleCode</b> — opencode on Telegram",
  "",
  "Type any message → prompt to the active session (streamed live).",
  "Photos/documents + caption → sent to the session.",
  "Approvals and questions arrive here as buttons.",
  "",
  "/menu — buttons for everything",
  "/new — fresh session (asks what to do) · /new &lt;title&gt;",
  "/sessions — list + tap to switch · /switch &lt;n&gt;",
  "/abort — stop current task · /cancel — drop a pending prompt",
  "/repo — list · /repo &lt;name&gt; — switch",
  "/repo add &lt;name&gt; &lt;path&gt; — add a repo",
  "/repo remove &lt;name&gt;",
  "/model [provider/model | list &lt;q&gt;]",
  "/agent [name] · /mode — plan/build toggle",
  "/diff · /todos · /cost · /share · /revert",
  "",
  "<b>Power tools</b>",
  "/commit [msg] · /push — git from your pocket",
  "/yolo — auto-approve permissions (toggle)",
  "/files — browse &amp; download workspace files",
  "/templates — quick-prompt buttons",
  "/schedule add &lt;spec&gt; | &lt;prompt&gt; — recurring runs",
  "/export — session transcript · /clone &lt;url&gt;",
  "/budget &lt;usd&gt; — cost alert · /team — share access",
  "🎙 Send a voice note → transcribed &amp; sent",
  "/pending — un-answered approvals · /status"
].join("\n");

function menuKeyboard() {
  return new InlineKeyboard()
    .text("🆕 New", "mn|new").text("📋 Sessions", "mn|sessions").row()
    .text("🔀 Git", "mn|git").text("⚡ Templates", "mn|templates").row()
    .text("📂 Files", "mn|files").text("🌿 Branch", "mn|branch").row()
    .text("🎛 Mode", "mn|mode").text("🤖 Agent", "mn|agent").row()
    .text("🧠 Model", "mn|model").text("📁 Repos", "mn|repo").row()
    .text("🔁 Diff", "mn|diff").text("✅ Todos", "mn|todos").row()
    .text("💰 Cost", "mn|cost").text("📊 Usage", "mn|usage").row()
    .text("⏰ Schedule", "mn|schedule").text("🔔 Pending", "mn|pending").row()
    .text("⚡ YOLO", "mn|yolo").text("🛑 Abort", "mn|abort").row()
    .text("📊 Status", "mn|status").text("❓ Help", "mn|help");
}

// A keyboard with just a Back-to-menu button (used by sub-panels).
function backKb() {
  return new InlineKeyboard().text("⬅️ Menu", "mn|home");
}

function menuView() {
  return {
    html: "<b>TeleCode — menu</b>\nTap an action, or just type a message to prompt the active session.",
    kb: menuKeyboard()
  };
}

// Edit the message a callback button is attached to; fall back to a fresh
// message if the edit fails (e.g. the message is too old or unchanged).
async function showView(ctx, view) {
  try {
    await ctx.editMessageText(view.html, { parse_mode: "HTML", reply_markup: view.kb });
  } catch (e) {
    if (!String(e.message || "").includes("not modified")) {
      await push(ctx.chat.id, view.html, { reply_markup: view.kb });
    }
  }
}

async function sendMenu(chatId) {
  const v = menuView();
  await push(chatId, v.html, { reply_markup: v.kb });
}

function newSessionView() {
  return {
    html: "🆕 <b>New session</b>\nTell me what you want to do (or a name for the session) and we'll start right away 👇\n\n<i>/cancel to abort.</i>",
    kb: backKb()
  };
}

async function askNewSession(chatId) {
  pendingInput.set(chatId, { type: "new_session" });
  const v = newSessionView();
  await push(chatId, v.html, { reply_markup: v.kb });
}

async function doAbort(chatId) {
  const repo = activeRepoName();
  const sid = state.get().activeSessions[repo];
  if (!sid) return push(chatId, "No active session.");
  try {
    await manager.get(repo).abortSession(sid);
    const key = turnKey(repo, sid);
    expectingTurn.delete(key);
    const view = turnViews.get(key);
    if (view && !view.closed) await view.finalize("");
    await push(chatId, "🛑 Abort sent.");
  } catch (e) {
    await push(chatId, `⚠️ Abort failed: ${esc(e.message)}`);
  }
}

async function diffView() {
  const repo = activeRepoName();
  const sid = state.get().activeSessions[repo];
  if (!sid) return { html: "No active session.", kb: backKb() };
  const diffs = await manager.get(repo).sessionDiff(sid);
  return { html: `<b>[${esc(repo)}] Diff</b>\n${fmtDiff(diffs)}`, kb: backKb() };
}

async function todosView() {
  const repo = activeRepoName();
  const sid = state.get().activeSessions[repo];
  if (!sid) return { html: "No active session.", kb: backKb() };
  const todos = await manager.get(repo).sessionTodo(sid);
  return { html: `<b>[${esc(repo)}] Todos</b>\n${fmtTodos(todos)}`, kb: backKb() };
}

async function costView() {
  const repo = activeRepoName();
  const sid = state.get().activeSessions[repo];
  if (!sid) return { html: "No active session.", kb: backKb() };
  const s = await manager.get(repo).sessionDetail(sid);
  return { html: `<b>[${esc(repo)}]</b> ${esc((s.title || "").slice(0, 50))}\n${fmtCost(s)}`, kb: backKb() };
}

async function modeView() {
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
  kb.text("⬅️ Menu", "mn|home");
  return {
    html: `🎛 [${esc(repo)}] agent: <b>${esc(cur)}</b>\n${cur === "plan" ? "Plan mode: read-only, no edits." : "Build mode: full edit + run powers."}\nTap to switch:`,
    kb
  };
}

function rememberModel(m) {
  if (!m) return;
  const next = [m, ...state.get().recentModels.filter((x) => x !== m)].slice(0, 6);
  state.set({ recentModels: next });
}

function modelView() {
  const repo = activeRepoName();
  const cur = state.get().activeModels[repo] || "(provider default)";
  const recent = state.get().recentModels || [];
  const kb = new InlineKeyboard();
  recent.slice(0, 6).forEach((mdl, i) => {
    kb.text(mdl.length > 30 ? "…" + mdl.slice(-29) : mdl, `ml|${i}`).row();
  });
  kb.text("⬅️ Menu", "mn|home");
  return {
    html: `🧠 [${esc(repo)}] model: <b>${esc(cur)}</b>\n${recent.length ? "Tap a recent model below, or " : ""}/model list [query] — browse\n/model provider/model — set · /model clear`,
    kb
  };
}

function reposView() {
  const repos = state.get().repos;
  const active = state.get().activeRepo;
  const names = Object.keys(repos);
  const kb = new InlineKeyboard();
  names.forEach((name, i) => {
    kb.text(`${name === active ? "▶️ " : ""}${name}`, `rp|${name}`);
    if (i % 2 === 1) kb.row();
  });
  if (names.length % 2 === 1) kb.row();
  kb.text("⬅️ Menu", "mn|home");
  const lines = Object.entries(repos).map(([name, r]) =>
    `${name === active ? "▶️" : "•"} <b>${esc(name)}</b> — <code>${esc(r.dir)}</code> :${r.port}`
  );
  return { html: `<b>Repos</b> — tap to switch\n${lines.join("\n") || "none"}\n\n/repo add &lt;name&gt; &lt;path&gt;`, kb };
}

async function agentView() {
  const repo = activeRepoName();
  const inst = manager.get(repo);
  let agents = [];
  try {
    agents = await inst.api("GET", "/agent");
  } catch {}
  const cur = state.get().activeAgents[repo];
  const top = agents.filter((a) => a.mode !== "subagent");
  const kb = new InlineKeyboard();
  top.slice(0, 10).forEach((a, i) => {
    kb.text(`${a.name === cur ? "● " : ""}${a.name}`, `ag|${a.name}`);
    if (i % 2 === 1) kb.row();
  });
  if (top.length % 2 === 1) kb.row();
  kb.text("⬅️ Menu", "mn|home");
  return { html: `🤖 <b>Agent — ${esc(repo)}</b>\ncurrent: <b>${esc(cur || "default")}</b>\nTap to set:`, kb };
}

const lastBranches = new Map();
async function branchView(chatId) {
  const repo = activeRepoName();
  const dir = repoDir(repo);
  const kb = new InlineKeyboard();
  if (!dir || !(await git.isRepo(dir))) {
    kb.text("⬅️ Menu", "mn|home");
    return { html: `🌿 <b>Branch — ${esc(repo)}</b>\n⚠️ Not a git repository.`, kb };
  }
  let info = { list: [], current: "" };
  try {
    info = await git.branches(dir);
  } catch {}
  lastBranches.set(chatId, info.list);
  info.list.slice(0, 12).forEach((b, i) => {
    kb.text(`${b === info.current ? "● " : ""}${b.slice(0, 24)}`, `br|co|${i}`);
    if (i % 2 === 1) kb.row();
  });
  if (info.list.length % 2 === 1) kb.row();
  kb.text("➕ New branch", "br|new").row().text("⬅️ Menu", "mn|home");
  return { html: `🌿 <b>Branch — ${esc(repo)}</b>\ncurrent: <b>${esc(info.current)}</b>\nTap to checkout:`, kb };
}

function scheduleView() {
  const list = state.get().schedules;
  const kb = new InlineKeyboard();
  list.forEach((s) => kb.text(`🗑 ${s.spec} — ${s.repo}`, `sch|del|${s.id}`).row());
  kb.text("⬅️ Menu", "mn|home");
  const body = list.length
    ? list.map((s) => `• <code>${esc(s.id)}</code> [${esc(s.repo)}] <b>${esc(s.spec)}</b>\n   ${esc(s.prompt.slice(0, 60))}`).join("\n")
    : "None yet.";
  return { html: `⏰ <b>Schedules</b>\n${body}\n\n/schedule add &lt;spec&gt; | &lt;prompt&gt;`, kb };
}

async function usageView() {
  const repo = activeRepoName();
  const inst = manager.get(repo);
  let sessions = [];
  try {
    sessions = await inst.listSessions();
  } catch {}
  let cost = 0;
  let tin = 0;
  let tout = 0;
  for (const s of sessions) {
    if (typeof s.cost === "number") cost += s.cost;
    const t = s.tokens || {};
    tin += t.input || 0;
    tout += t.output || 0;
  }
  const limit = state.get().budgetLimit;
  return {
    html: `📊 <b>Usage — ${esc(repo)}</b>\nsessions: <b>${sessions.length}</b>\ntotal cost: <b>$${cost.toFixed(4)}</b>\ntokens: ${tin} in / ${tout} out\nbudget alert: <b>${limit ? "$" + limit.toFixed(4) : "off"}</b>`,
    kb: backKb()
  };
}

async function statusView() {
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
  const yolo = state.get().yolo[repo] ? "ON ⚡" : "off";
  return {
    html: `🟢 TeleCode bridge\nopencode: <code>${esc(version)}</code>\nrepo: <b>${esc(repo)}</b>\nsession: ${esc(title)}\n<code>${esc(sid || "-")}</code>\nstatus: <b>${esc(statusLine)}</b>\nmodel: <b>${esc(state.get().activeModels[repo] || "default")}</b>\nagent: <b>${esc(state.get().activeAgents[repo] || "default")}</b>\nyolo: <b>${yolo}</b>\npending asks: ${pendingAsks.size}`,
    kb: backKb()
  };
}

async function doDiff(chatId) {
  const v = await diffView();
  await push(chatId, v.html, { reply_markup: v.kb });
}
async function doTodos(chatId) {
  const v = await todosView();
  await push(chatId, v.html, { reply_markup: v.kb });
}
async function doCost(chatId) {
  const v = await costView();
  await push(chatId, v.html, { reply_markup: v.kb });
}
async function doMode(chatId) {
  const v = await modeView();
  await push(chatId, v.html, { reply_markup: v.kb });
}
async function doModelInfo(chatId) {
  const v = modelView();
  await push(chatId, v.html, { reply_markup: v.kb });
}
async function doRepoList(chatId) {
  const v = reposView();
  await push(chatId, v.html, { reply_markup: v.kb });
}
async function doStatus(chatId) {
  const v = await statusView();
  await push(chatId, v.html, { reply_markup: v.kb });
}

// ── YOLO (auto-approve) ────────────────────────────────────────────────
function yoloView() {
  const repo = activeRepoName();
  const on = !!state.get().yolo[repo];
  const kb = new InlineKeyboard()
    .text(on ? "🛡 Turn OFF" : "⚡ Turn ON", "mn|yolotoggle")
    .row()
    .text("⬅️ Menu", "mn|home");
  return {
    html: on
      ? `🤖 <b>YOLO — ${esc(repo)}</b>\n⚡ <b>ON</b> — permission requests are auto-approved. Use with care.`
      : `🤖 <b>YOLO — ${esc(repo)}</b>\n🛡 <b>OFF</b> — you'll be asked to approve each time.`,
    kb
  };
}

async function doYolo(chatId) {
  const repo = activeRepoName();
  const next = !state.get().yolo[repo];
  state.set({ yolo: { ...state.get().yolo, [repo]: next } });
  await push(
    chatId,
    next
      ? `⚡ <b>YOLO ON</b> for <b>${esc(repo)}</b> — permission requests are auto-approved. Use with care.`
      : `🛡 <b>YOLO OFF</b> for <b>${esc(repo)}</b> — you'll be asked to approve again.`
  );
}

// ── Git actions ────────────────────────────────────────────────────────
async function requireGit(chatId) {
  const repo = activeRepoName();
  const dir = repoDir(repo);
  if (!dir || !(await git.isRepo(dir))) {
    await push(chatId, "⚠️ The active repo is not a git repository.");
    return null;
  }
  return { repo, dir };
}

async function doCommit(chatId, message) {
  const g = await requireGit(chatId);
  if (!g) return;
  let changed;
  try {
    changed = await git.changes(g.dir);
  } catch (e) {
    return push(chatId, `⚠️ ${esc(e.message)}`);
  }
  if (!changed.length) return push(chatId, "Nothing to commit — working tree clean.");
  const msg = (message && message.trim()) || git.suggestMessage(changed);
  try {
    await git.commitAll(g.dir, msg);
    const kb = new InlineKeyboard().text("🚀 Push", "git|push");
    await push(chatId, `✅ Committed <b>${changed.length}</b> file(s):\n<code>${esc(msg)}</code>`, { reply_markup: kb });
  } catch (e) {
    await push(chatId, `⚠️ Commit failed: <code>${esc((e.stderr || e.message || "").slice(-500))}</code>`);
  }
}

async function doPush(chatId) {
  const g = await requireGit(chatId);
  if (!g) return;
  try {
    const out = await git.push(g.dir);
    const branch = await git.currentBranch(g.dir);
    const url = git.prUrl(await git.remoteUrl(g.dir), branch);
    const extra = url ? { reply_markup: new InlineKeyboard().url("🔀 Open PR", url) } : {};
    await push(chatId, `🚀 Pushed <b>${esc(branch)}</b>.\n<code>${esc((out || "done").slice(-400))}</code>`, extra);
  } catch (e) {
    await push(chatId, `⚠️ Push failed: <code>${esc((e.stderr || e.message || "").slice(-500))}</code>`);
  }
}

// Typing indicator while the agent works (refcounted per chat).
const typingTimers = new Map();
function startTyping(chatId) {
  const t = typingTimers.get(chatId);
  if (t) {
    t.count++;
    return;
  }
  const send = () => bot.api.sendChatAction(chatId, "typing").catch(() => {});
  send();
  typingTimers.set(chatId, { timer: setInterval(send, 4500), count: 1 });
}
function stopTyping(chatId) {
  const t = typingTimers.get(chatId);
  if (!t) return;
  t.count--;
  if (t.count <= 0) {
    clearInterval(t.timer);
    typingTimers.delete(chatId);
  }
}

// Compact control bar shown after a turn ends: Continue + Git (if changes) + Menu.
async function offerTurnControls(chatId) {
  const repo = activeRepoName();
  const dir = repoDir(repo);
  let changed = 0;
  if (dir && (await git.isRepo(dir))) {
    try {
      changed = (await git.changes(dir)).length;
    } catch {}
  }
  const kb = new InlineKeyboard().text("▶️ Continue", "cont");
  if (changed) kb.text("🔀 Git", "mn|git");
  kb.row().text("🏠 Menu", "mn|home");
  await push(chatId, changed ? `✅ Done · <b>${changed}</b> change(s)` : "✅ Done", { reply_markup: kb });
}

async function doRevert(chatId) {
  const repo = activeRepoName();
  const sid = state.get().activeSessions[repo];
  if (!sid) return push(chatId, "No active session.");
  const inst = manager.get(repo);
  const msgs = await inst.api("GET", `/session/${sid}/message`);
  const lastUser = [...msgs].reverse().find((m) => m.info.role === "user");
  if (!lastUser) return push(chatId, "Nothing to revert.");
  await inst.revertSession(sid, lastUser.info.id);
  await push(chatId, "⏪ Reverted last turn.");
}

async function doFullDiffFile(chatId) {
  const g = await requireGit(chatId);
  if (!g) return;
  try {
    const { stdout } = await git.git(g.dir, ["diff", "HEAD"]);
    if (!stdout.trim()) return push(chatId, "No diff vs HEAD.");
    await sendDoc(chatId, `diff-${Date.now()}.diff`, stdout, `${g.repo} diff`);
  } catch (e) {
    await push(chatId, `⚠️ ${esc(e.message)}`);
  }
}


// Git panel for the menu (always returns a view, with a Back button).
async function gitView() {
  const repo = activeRepoName();
  const dir = repoDir(repo);
  const kb = new InlineKeyboard();
  if (!dir || !(await git.isRepo(dir))) {
    kb.text("⬅️ Menu", "mn|home");
    return { html: `🔀 <b>Git — ${esc(repo)}</b>\n⚠️ Not a git repository.`, kb };
  }
  let changed = [];
  try {
    changed = await git.changes(dir);
  } catch {}
  if (changed.length) {
    kb.text("📥 Commit & push", "git|commitpush").text("🔁 Diff", "git|diff").row();
    kb.text("📄 Diff file", "git|difffile").text("⏪ Revert turn", "git|revert").row();
  }
  kb.text("⬅️ Menu", "mn|home");
  return {
    html: changed.length
      ? `🔀 <b>Git — ${esc(repo)}</b>\n${changed.length} uncommitted change(s).`
      : `🔀 <b>Git — ${esc(repo)}</b>\n✅ Working tree clean.`,
    kb
  };
}

// ── Quick-prompt templates ─────────────────────────────────────────────
const TEMPLATES = {
  tests: { label: "🧪 Run tests", prompt: "Run the test suite and fix any failures." },
  lint: { label: "🧹 Fix lint", prompt: "Run the linter/formatter and fix all reported issues." },
  commitmsg: { label: "✍️ Commit msg", prompt: "Summarize the current uncommitted changes and propose one conventional commit message. Do not commit." },
  review: { label: "🔎 Review changes", prompt: "Review my uncommitted changes for bugs, security issues, and improvements. Be concise." }
};

function templatesView() {
  const kb = new InlineKeyboard();
  Object.keys(TEMPLATES).forEach((k, i) => {
    kb.text(TEMPLATES[k].label, `tpl|${k}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("⬅️ Menu", "mn|home");
  return { html: "<b>Quick prompts</b>\nTap one to run it on the active session:", kb };
}

async function doTemplates(chatId) {
  const v = templatesView();
  await push(chatId, v.html, { reply_markup: v.kb });
}

// ── File browser ───────────────────────────────────────────────────────
const lastBrowse = new Map();

function filesView(chatId, rel) {
  const repo = activeRepoName();
  const dir = repoDir(repo);
  if (!dir) return { html: "⚠️ No active repo.", kb: backKb() };
  let listing;
  try {
    listing = files.list(dir, rel || ".");
  } catch (e) {
    return { html: `⚠️ ${esc(e.message)}`, kb: backKb() };
  }
  lastBrowse.set(chatId, listing);
  const kb = new InlineKeyboard();
  if (listing.rel !== ".") kb.text("⬆️ ..", "fb|up").row();
  listing.dirs.forEach((d, i) => {
    kb.text(`📁 ${d.slice(0, 24)}`, `fb|o|${i}`);
    if (i % 2 === 1) kb.row();
  });
  if (listing.dirs.length % 2 === 1) kb.row();
  listing.files.forEach((f, i) => {
    kb.text(`📄 ${f.slice(0, 24)}`, `fb|v|${i}`).text("⬇️", `fb|d|${i}`).row();
  });
  kb.text("⬅️ Menu", "mn|home");
  const where = listing.rel === "." ? "" : listing.rel;
  const empty = listing.dirs.length + listing.files.length ? "" : "\n<i>(empty)</i>";
  return { html: `<b>📂 ${esc(repo)}:/${esc(where)}</b>${empty}`, kb };
}

async function doFiles(chatId, rel) {
  const v = filesView(chatId, rel || ".");
  await push(chatId, v.html, { reply_markup: v.kb });
}

// ── Export transcript ──────────────────────────────────────────────────
async function doExport(chatId) {
  const repo = activeRepoName();
  const sid = state.get().activeSessions[repo];
  if (!sid) return push(chatId, "No active session.");
  const inst = manager.get(repo);
  const msgs = await inst.api("GET", `/session/${sid}/message`);
  const lines = [`# Session ${sid}`, `repo: ${repo}`, ""];
  for (const m of msgs) {
    const text = (m.parts || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    if (!text.trim()) continue;
    lines.push(`## ${m.info.role}`, "", text, "");
  }
  await sendDoc(chatId, `session-${sid}.md`, lines.join("\n"), "Session transcript");
}

// ── Clone a repo ───────────────────────────────────────────────────────
async function doClone(chatId, url, name) {
  if (!url) return push(chatId, "Usage: /clone &lt;git-url&gt; [name]");
  const base = (name || url.split("/").pop() || "repo").replace(/\.git$/, "");
  const safe = base.toLowerCase().replace(/[^a-z0-9-]/g, "") || "repo";
  const parent = path.dirname(repoDir(activeRepoName()) || process.cwd());
  const target = path.join(parent, safe);
  if (fs.existsSync(target)) return push(chatId, `⚠️ <code>${esc(target)}</code> already exists.`);
  if (state.get().repos[safe]) return push(chatId, `⚠️ Repo name <b>${esc(safe)}</b> is taken.`);
  await push(chatId, `⏳ Cloning into <code>${esc(target)}</code> …`);
  try {
    await git.clone(url, target);
  } catch (e) {
    return push(chatId, `⚠️ Clone failed: <code>${esc((e.stderr || e.message || "").slice(-500))}</code>`);
  }
  const port = manager.allocPort();
  manager.register(safe, target, port);
  state.set({ repos: { ...state.get().repos, [safe]: { dir: target, port } }, activeRepo: safe });
  try {
    await manager.get(safe).ensure();
    manager.get(safe).watchEvents(handleEvent(safe));
  } catch (e) {
    return push(chatId, `Cloned & added, but the server failed to start: ${esc(e.message)}`);
  }
  await push(chatId, `✅ Cloned & active: <b>${esc(safe)}</b>\n<code>${esc(target)}</code> :${port}`);
}

// ── Budget alert ───────────────────────────────────────────────────────
const budgetNotified = new Set();
async function maybeBudgetAlert(repo, sid) {
  const limit = state.get().budgetLimit;
  if (!limit) return;
  const key = `${repo}|${sid}`;
  if (budgetNotified.has(key)) return;
  try {
    const s = await manager.get(repo).sessionDetail(sid);
    if ((s.cost || 0) >= limit) {
      budgetNotified.add(key);
      await push(ownerChat(), `⚠️ <b>Budget alert</b> — [${esc(repo)}] session cost $${(s.cost || 0).toFixed(4)} ≥ limit $${limit.toFixed(4)}.`);
    }
  } catch {}
}

// ── Scheduler ──────────────────────────────────────────────────────────
function parseSchedule(spec) {
  const s = (spec || "").trim().toLowerCase();
  let m;
  if ((m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/))) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { type: "daily", hour, minute };
  }
  if ((m = s.match(/^every\s+(\d+)\s*(m|h)$/))) {
    return { type: "interval", ms: Number(m[1]) * (m[2] === "h" ? 3600000 : 60000) };
  }
  return null;
}

async function doScheduleList(chatId) {
  const list = state.get().schedules;
  if (!list.length) {
    return push(
      chatId,
      "<b>Schedules</b>\nNone yet.\n\n/schedule add &lt;spec&gt; | &lt;prompt&gt;\nspec = <code>daily HH:MM</code> or <code>every 30m</code> / <code>every 2h</code>"
    );
  }
  const lines = list.map(
    (s) => `• <code>${esc(s.id)}</code> [${esc(s.repo)}] <b>${esc(s.spec)}</b>\n   ${esc(s.prompt.slice(0, 80))}`
  );
  await push(chatId, `<b>Schedules</b>\n${lines.join("\n")}\n\n/schedule remove &lt;id&gt;`);
}

function startScheduler() {
  setInterval(async () => {
    const now = Date.now();
    const d = new Date();
    let changedState = false;
    for (const sc of state.get().schedules) {
      let due = false;
      if (sc.type === "interval") due = !sc.lastRun || now - sc.lastRun >= sc.ms;
      else if (sc.type === "daily") {
        if (d.getHours() === sc.hour && d.getMinutes() === sc.minute) {
          due = !sc.lastRun || now - sc.lastRun > 90 * 1000;
        }
      }
      if (!due) continue;
      sc.lastRun = now;
      changedState = true;
      try {
        if (sc.repo && state.get().repos[sc.repo]) state.set({ activeRepo: sc.repo });
        await push(ownerChat(), `⏰ Scheduled run [${esc(sc.repo)}]: <code>${esc(sc.prompt.slice(0, 80))}</code>`);
        await sendPrompt(ownerChat(), [{ type: "text", text: sc.prompt }]);
      } catch (e) {
        console.error("[sched] fire failed:", e.message);
      }
    }
    if (changedState) state.set({ schedules: state.get().schedules });
  }, 30000).unref();
}

function registerCommands() {
  bot.command("start", (ctx) => push(ctx.chat.id, HELP_TEXT));
  bot.command("help", (ctx) => push(ctx.chat.id, HELP_TEXT));
  bot.command("menu", (ctx) => sendMenu(ctx.chat.id));
  bot.command("yolo", (ctx) => doYolo(ctx.chat.id));
  bot.command("commit", (ctx) => doCommit(ctx.chat.id, (ctx.match || "").trim()));
  bot.command("push", (ctx) => doPush(ctx.chat.id));
  bot.command("files", (ctx) => doFiles(ctx.chat.id, (ctx.match || "").trim() || "."));
  bot.command("export", (ctx) => doExport(ctx.chat.id));
  bot.command("templates", (ctx) => doTemplates(ctx.chat.id));
  bot.command("branch", async (ctx) => {
    const v = await branchView(ctx.chat.id);
    await push(ctx.chat.id, v.html, { reply_markup: v.kb });
  });
  bot.command("usage", async (ctx) => {
    const v = await usageView();
    await push(ctx.chat.id, v.html, { reply_markup: v.kb });
  });
  bot.command("clone", (ctx) => {
    const arg = (ctx.match || "").trim().split(/\s+/);
    doClone(ctx.chat.id, arg[0], arg[1]);
  });

  bot.command("budget", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) {
      const cur = state.get().budgetLimit;
      return push(ctx.chat.id, `💰 Budget alert limit: <b>${cur ? "$" + cur.toFixed(4) : "off"}</b>\n/budget &lt;amount&gt; — set (0 = off)`);
    }
    const n = Number(arg);
    if (Number.isNaN(n) || n < 0) return push(ctx.chat.id, "Usage: /budget &lt;amount in USD&gt;");
    state.set({ budgetLimit: n });
    budgetNotified.clear();
    await push(ctx.chat.id, n ? `💰 Budget alert set to $${n.toFixed(4)}.` : "💰 Budget alert disabled.");
  });

  bot.command("schedule", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) return doScheduleList(ctx.chat.id);
    if (arg.startsWith("remove ")) {
      const id = arg.slice(7).trim();
      const next = state.get().schedules.filter((s) => s.id !== id);
      if (next.length === state.get().schedules.length) return push(ctx.chat.id, "No such schedule id.");
      state.set({ schedules: next });
      return push(ctx.chat.id, `🗑 Removed schedule <code>${esc(id)}</code>.`);
    }
    if (arg.startsWith("add ")) {
      const rest = arg.slice(4);
      const bar = rest.indexOf("|");
      if (bar < 0) return push(ctx.chat.id, "Usage: /schedule add &lt;spec&gt; | &lt;prompt&gt;");
      const spec = rest.slice(0, bar).trim();
      const prompt = rest.slice(bar + 1).trim();
      const parsed = parseSchedule(spec);
      if (!parsed) return push(ctx.chat.id, "Bad spec. Use <code>daily HH:MM</code> or <code>every 30m</code> / <code>every 2h</code>.");
      if (!prompt) return push(ctx.chat.id, "Add a prompt after the <code>|</code>.");
      const id = "sc" + Math.random().toString(36).slice(2, 8);
      const sc = { id, spec, prompt, repo: activeRepoName(), ...parsed, lastRun: 0 };
      state.set({ schedules: [...state.get().schedules, sc] });
      return push(ctx.chat.id, `⏰ Scheduled <code>${esc(id)}</code> — <b>${esc(spec)}</b> on <b>${esc(sc.repo)}</b>.`);
    }
    await doScheduleList(ctx.chat.id);
  });

  bot.command("team", async (ctx) => {
    if (String(ctx.from?.id) !== currentOwner()) return push(ctx.chat.id, "Only the owner can manage the team.");
    const arg = (ctx.match || "").trim();
    const allowed = state.get().allowedUsers;
    if (!arg) {
      const lines = allowed.length ? allowed.map((u) => `• <code>${esc(String(u))}</code>`).join("\n") : "none";
      return push(ctx.chat.id, `<b>Allowed users</b> (besides you)\n${lines}\n\n/team add &lt;id&gt; · /team remove &lt;id&gt;`);
    }
    if (arg.startsWith("add ")) {
      const id = Number(arg.slice(4).trim());
      if (!id) return push(ctx.chat.id, "Usage: /team add &lt;numeric id&gt;");
      if (allowed.includes(id)) return push(ctx.chat.id, "Already added.");
      state.set({ allowedUsers: [...allowed, id] });
      return push(ctx.chat.id, `👥 Added <code>${esc(String(id))}</code>.`);
    }
    if (arg.startsWith("remove ")) {
      const id = Number(arg.slice(7).trim());
      state.set({ allowedUsers: allowed.filter((u) => u !== id) });
      return push(ctx.chat.id, `👥 Removed <code>${esc(String(id))}</code>.`);
    }
    await push(ctx.chat.id, "Usage: /team add|remove &lt;id&gt;");
  });

  bot.command("new", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) return askNewSession(ctx.chat.id);
    await startNewSession(ctx.chat.id, arg);
  });

  bot.command("cancel", async (ctx) => {
    if (pendingInput.delete(ctx.chat.id)) await push(ctx.chat.id, "✖️ Cancelled.");
    else await push(ctx.chat.id, "Nothing pending to cancel.");
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

  bot.command("abort", (ctx) => doAbort(ctx.chat.id));

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
    rememberModel(arg);
    await push(ctx.chat.id, `🧠 [${esc(repo)}] Model set: <b>${esc(arg)}</b>`);
  });

  bot.command("mode", (ctx) => doMode(ctx.chat.id));

  bot.command("agent", async (ctx) => {
    const repo = activeRepoName();
    const inst = manager.get(repo);
    const arg = (ctx.match || "").trim();
    if (!arg) {
      const v = await agentView();
      await push(ctx.chat.id, v.html, { reply_markup: v.kb });
      return;
    }
    const agents = await inst.api("GET", "/agent");
    const found = agents.find((a) => a.name === arg);
    if (!found) {
      await push(ctx.chat.id, `⚠️ No agent named <code>${esc(arg)}</code>`);
      return;
    }
    state.set({ activeAgents: { ...state.get().activeAgents, [repo]: arg } });
    await push(ctx.chat.id, `🤖 [${esc(repo)}] Agent set: <b>${esc(arg)}</b>`);
  });

  bot.command("diff", (ctx) => doDiff(ctx.chat.id));
  bot.command("todos", (ctx) => doTodos(ctx.chat.id));
  bot.command("cost", (ctx) => doCost(ctx.chat.id));

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

  bot.command("status", (ctx) => doStatus(ctx.chat.id));

  bot.command("pending", async (ctx) => {
    await announcePending();
    if (pendingAsks.size === 0) await push(ctx.chat.id, "Nothing pending.");
  });
}

function registerCallbacks() {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    try {
      if (data.startsWith("mn|")) {
        const [, action] = data.split("|");
        console.log(`[cb] menu action: ${data}`);
        const chatId = ctx.chat.id;
        await ctx.answerCallbackQuery().catch(() => {});
        switch (action) {
          case "home": await showView(ctx, menuView()); break;
          case "new": pendingInput.set(chatId, { type: "new_session" }); await showView(ctx, newSessionView()); break;
          case "sessions": await showView(ctx, await sessionsView()); break;
          case "status": await showView(ctx, await statusView()); break;
          case "mode": await showView(ctx, await modeView()); break;
          case "diff": await showView(ctx, await diffView()); break;
          case "todos": await showView(ctx, await todosView()); break;
          case "cost": await showView(ctx, await costView()); break;
          case "model": await showView(ctx, modelView()); break;
          case "repo": await showView(ctx, reposView()); break;
          case "agent": await showView(ctx, await agentView()); break;
          case "branch": await showView(ctx, await branchView(chatId)); break;
          case "schedule": await showView(ctx, scheduleView()); break;
          case "usage": await showView(ctx, await usageView()); break;
          case "pending": {
            await announcePending();
            await showView(ctx, {
              html: pendingAsks.size ? `🔔 <b>${pendingAsks.size}</b> pending — answer via the buttons above.` : "✅ Nothing pending.",
              kb: backKb()
            });
            break;
          }
          case "git": await showView(ctx, await gitView()); break;
          case "templates": await showView(ctx, templatesView()); break;
          case "files": await showView(ctx, filesView(chatId, ".")); break;
          case "yolo": await showView(ctx, yoloView()); break;
          case "yolotoggle": {
            const repo = activeRepoName();
            state.set({ yolo: { ...state.get().yolo, [repo]: !state.get().yolo[repo] } });
            await showView(ctx, yoloView());
            break;
          }
          case "abort": await doAbort(chatId); await showView(ctx, menuView()); break;
          case "help": await showView(ctx, { html: HELP_TEXT, kb: backKb() }); break;
          default: break;
        }
        return;
      }
      if (data.startsWith("git|")) {
        const [, act] = data.split("|");
        console.log(`[cb] git action: ${data}`);
        await ctx.answerCallbackQuery().catch(() => {});
        if (act === "commit") await doCommit(ctx.chat.id);
        else if (act === "push") await doPush(ctx.chat.id);
        else if (act === "commitpush") {
          await doCommit(ctx.chat.id);
          await doPush(ctx.chat.id);
        } else if (act === "diff") await doDiff(ctx.chat.id);
        else if (act === "difffile") await doFullDiffFile(ctx.chat.id);
        else if (act === "revert") {
          const kb = new InlineKeyboard().text("✅ Yes, revert", "git|revertyes").text("✖️ Cancel", "git|cancel");
          await push(ctx.chat.id, "⏪ Revert the last turn? This undoes the last changes.", { reply_markup: kb });
        } else if (act === "revertyes") await doRevert(ctx.chat.id);
        else if (act === "cancel") await ctx.editMessageText("✖️ Cancelled.").catch(() => {});
        return;
      }
      if (data.startsWith("rp|")) {
        const [, name] = data.split("|");
        console.log(`[cb] repo switch: ${data}`);
        await ctx.answerCallbackQuery().catch(() => {});
        if (state.get().repos[name]) state.set({ activeRepo: name });
        await showView(ctx, reposView());
        return;
      }
      if (data.startsWith("ag|")) {
        const [, name] = data.split("|");
        console.log(`[cb] agent set: ${data}`);
        const repo = activeRepoName();
        state.set({ activeAgents: { ...state.get().activeAgents, [repo]: name } });
        await ctx.answerCallbackQuery({ text: `Agent: ${name}` }).catch(() => {});
        await showView(ctx, await agentView());
        return;
      }
      if (data.startsWith("ml|")) {
        const [, iStr] = data.split("|");
        console.log(`[cb] model pick: ${data}`);
        await ctx.answerCallbackQuery().catch(() => {});
        const mdl = state.get().recentModels[Number(iStr)];
        if (mdl) {
          const repo = activeRepoName();
          state.set({ activeModels: { ...state.get().activeModels, [repo]: mdl } });
          rememberModel(mdl);
        }
        await showView(ctx, modelView());
        return;
      }
      if (data.startsWith("br|")) {
        const [, act, iStr] = data.split("|");
        console.log(`[cb] branch: ${data}`);
        await ctx.answerCallbackQuery().catch(() => {});
        const dir = repoDir(activeRepoName());
        if (act === "new") {
          pendingInput.set(ctx.chat.id, { type: "branch_new" });
          await showView(ctx, { html: "🌿 <b>New branch</b>\nSend the branch name.\n\n<i>/cancel to abort.</i>", kb: backKb() });
        } else if (act === "co") {
          const list = lastBranches.get(ctx.chat.id) || [];
          const name = list[Number(iStr)];
          if (name && dir) {
            try {
              await git.checkout(dir, name);
            } catch (e) {
              await push(ctx.chat.id, `⚠️ Checkout failed: <code>${esc((e.stderr || e.message || "").slice(-300))}</code>`);
            }
          }
          await showView(ctx, await branchView(ctx.chat.id));
        }
        return;
      }
      if (data.startsWith("sch|")) {
        const [, act, id] = data.split("|");
        console.log(`[cb] schedule: ${data}`);
        await ctx.answerCallbackQuery().catch(() => {});
        if (act === "del") {
          const kb = new InlineKeyboard().text("✅ Delete", `sch|yes|${id}`).text("✖️ Cancel", "mn|schedule");
          await showView(ctx, { html: `Delete schedule <code>${esc(id)}</code>?`, kb });
        } else if (act === "yes") {
          state.set({ schedules: state.get().schedules.filter((s) => s.id !== id) });
          await showView(ctx, scheduleView());
        }
        return;
      }
      if (data === "cont") {
        console.log("[cb] continue");
        await ctx.answerCallbackQuery({ text: "Continuing…" }).catch(() => {});
        await sendPrompt(ctx.chat.id, [{ type: "text", text: "Continue." }]);
        return;
      }
      if (data.startsWith("tpl|")) {
        const [, k] = data.split("|");
        console.log(`[cb] template: ${data}`);
        await ctx.answerCallbackQuery().catch(() => {});
        const t = TEMPLATES[k];
        if (t) await sendPrompt(ctx.chat.id, [{ type: "text", text: t.prompt }]);
        return;
      }
      if (data.startsWith("fb|")) {
        const [, act, iStr] = data.split("|");
        console.log(`[cb] files: ${data}`);
        await ctx.answerCallbackQuery().catch(() => {});
        const b = lastBrowse.get(ctx.chat.id);
        if (!b) {
          await push(ctx.chat.id, "File list expired — /files again.");
          return;
        }
        const dir = repoDir(activeRepoName());
        const join = (name) => (b.rel === "." ? "" : b.rel + "/") + name;
        if (act === "up") {
          const parent = b.rel === "." ? "." : b.rel.split("/").slice(0, -1).join("/") || ".";
          await showView(ctx, filesView(ctx.chat.id, parent));
        } else if (act === "o") {
          const name = b.dirs[Number(iStr)];
          if (name) await showView(ctx, filesView(ctx.chat.id, join(name)));
        } else if (act === "v" || act === "d") {
          const name = b.files[Number(iStr)];
          if (!name) return;
          const rel = join(name);
          let f;
          try {
            f = files.readFile(dir, rel);
          } catch (e) {
            await push(ctx.chat.id, `⚠️ ${esc(e.message)}`);
            return;
          }
          if (act === "d" || f.size > files.MAX_VIEW_BYTES || !files.isProbablyText(f.buffer)) {
            await sendDoc(ctx.chat.id, name, f.buffer, rel);
          } else {
            await push(ctx.chat.id, `<b>${esc(rel)}</b>\n<pre><code>${esc(f.buffer.toString("utf8"))}</code></pre>`);
          }
        }
        return;
      }
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
        await ctx.answerCallbackQuery({ text: `Agent: ${name}` });
        await showView(ctx, await modeView());
      } else if (data.startsWith("sw|")) {
        const [, idx] = data.split("|");
        console.log(`[cb] session switch: ${data}`);
        const repo = activeRepoName();
        const list = state.get().lastSessionLists[repo] || [];
        const sid = list[Number(idx)];
        if (!sid) {
          await ctx.answerCallbackQuery({ text: "Session no longer listed — /sessions" });
          return;
        }
        state.set({ activeSessions: { ...state.get().activeSessions, [repo]: sid } });
        await ctx.answerCallbackQuery({ text: `Switched to #${Number(idx) + 1} ✅` });
        await showView(ctx, await sessionsView());
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
      if (pend.type === "branch_new") {
        const dir = repoDir(activeRepoName());
        const name = text.trim().replace(/\s+/g, "-");
        if (!dir || !(await git.isRepo(dir))) {
          await push(chatId, "⚠️ The active repo is not a git repository.");
          return;
        }
        try {
          await git.createBranch(dir, name);
          await push(chatId, `🌿 Created & switched to <b>${esc(name)}</b>.`);
        } catch (e) {
          await push(chatId, `⚠️ Could not create branch: <code>${esc((e.stderr || e.message || "").slice(-300))}</code>`);
        }
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

async function handleVoice(ctx, fileId, name, caption) {
  const chatId = ctx.chat.id;
  if (!stt.enabled()) {
    await push(chatId, "🎙 Voice not configured — add STT_API_KEY (and optionally STT_API_URL / STT_MODEL) to .env to enable transcription.");
    return;
  }
  try {
    const { buffer } = await media.downloadTelegramFile(TOKEN, fileId);
    await push(chatId, "🎙 Transcribing…");
    let text;
    try {
      text = await stt.transcribe(buffer, name);
    } catch (e) {
      await push(chatId, `⚠️ Transcription failed: <code>${esc(e.message)}</code>`);
      return;
    }
    if (!text) {
      await push(chatId, "🎙 Couldn't make out any speech.");
      return;
    }
    await push(chatId, `🎙 <i>${esc(text)}</i>`);
    const prompt = caption ? `${caption}\n\n${text}` : text;
    await sendPrompt(chatId, [{ type: "text", text: prompt }]);
  } catch (e) {
    await push(chatId, `⚠️ Voice handling failed: <code>${esc(e.message)}</code>`);
  }
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

  bot.on("message:voice", async (ctx) => handleVoice(ctx, ctx.message.voice.file_id, "voice.ogg", ctx.message.caption));
  bot.on("message:audio", async (ctx) =>
    handleVoice(ctx, ctx.message.audio.file_id, ctx.message.audio.file_name || "audio.mp3", ctx.message.caption)
  );
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
  startScheduler();
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
    { command: "menu", description: "Open the button menu" },
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
    { command: "commit", description: "Commit all changes" },
    { command: "push", description: "Push to remote" },
    { command: "yolo", description: "Toggle auto-approve" },
    { command: "files", description: "Browse workspace files" },
    { command: "templates", description: "Quick-prompt buttons" },
    { command: "schedule", description: "Recurring prompts" },
    { command: "branch", description: "Switch / create branch" },
    { command: "usage", description: "Cost across sessions" },
    { command: "export", description: "Export transcript" },
    { command: "clone", description: "Clone a git repo" },
    { command: "budget", description: "Cost alert limit" },
    { command: "team", description: "Manage allowed users" },
    { command: "share", description: "Get share URL" },
    { command: "revert", description: "Undo last turn" },
    { command: "pending", description: "Pending approvals/questions" },
    { command: "status", description: "Bridge status" },
    { command: "help", description: "How to use" }
  ]);

  if (currentOwner()) {
    await push(
      ownerChat(),
      `✅ TeleCode is running.\nrepo: <b>${esc(activeRepoName())}</b> · streaming on · ${manager.instances.size} server${manager.instances.size === 1 ? "" : "s"}\n\nSend /menu for buttons, or just type what you want to build.`
    );
    await announcePending();
  } else {
    console.log("[bridge] no owner yet — PAIRING mode: first Telegram user to message the bot becomes the owner");
  }

  await bot.start({ onStart: () => console.log("[bridge] telegram polling started") });
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
