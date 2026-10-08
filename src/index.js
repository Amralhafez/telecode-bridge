require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const oc = require("./oc");
const state = require("./state");
const { mdToHtml, splitHtml, esc } = require("./format");

const OWNER = String(process.env.TELEGRAM_OWNER_ID || "");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (!TOKEN || !OWNER) {
  console.error("[bridge] TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID are required");
  process.exit(1);
}

const sentMessages = new Set();
const toolSeen = new Set();
const expectingText = new Set();
const retryNotified = new Set();
const pendingAsks = new Map();
let bot;

const ownerChat = () => state.get().chatId || Number(OWNER);

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

async function activeSession() {
  const sid = state.get().activeSessionId;
  if (sid) {
    try {
      const sessions = await oc.listSessions();
      if (sessions.some((s) => s.id === sid)) return sid;
    } catch {}
  }
  const s = await oc.createSession(`tg ${new Date().toISOString().slice(0, 16)}`);
  state.set({ activeSessionId: s.id });
  return s.id;
}

async function sendPrompt(chatId, text) {
  const sid = await activeSession();
  try {
    await oc.promptAsync(sid, text);
  } catch (e) {
    await push(chatId, `⚠️ Could not send: <code>${esc(e.message)}</code>\nSession may be busy — /abort to stop it.`);
    return;
  }
  expectingText.add(sid);
  await push(chatId, "⏳ Working on it…");
}

function toolArg(part) {
  const i = part.state?.input || {};
  const v = i.command || i.description || i.url || i.query || i.pattern || i.filePath || i.file_path || "";
  return String(v).slice(0, 120);
}

async function handleEvent(ev) {
  try {
    switch (ev.type) {
      case "permission.asked":
        return await onPermissionAsked(ev.properties);
      case "question.asked":
        return await onQuestionAsked(ev.properties);
      case "message.updated":
        return await onMessageUpdated(ev.properties);
      case "message.part.updated":
        return await onPartUpdated(ev.properties);
      case "session.status":
        return await onSessionStatus(ev.properties);
      case "session.idle":
        return await onSessionIdle(ev.properties);
    }
  } catch (e) {
    console.error(`[ev] ${ev.type} handler failed:`, e.message);
  }
}

async function onPermissionAsked(p) {
  const what = p.metadata?.command || (p.patterns || []).join(", ") || p.permission;
  const html = `🔐 <b>Permission needed</b>\ntool: <code>${esc(p.permission)}</code>\n<code>${esc(what)}</code>`;
  const kb = new InlineKeyboard()
    .text("✅ Once", `p|${p.id}|once`)
    .text("🔁 Always", `p|${p.id}|always`)
    .text("❌ Deny", `p|${p.id}|reject`);
  const msgs = await push(ownerChat(), html, { reply_markup: kb });
  pendingAsks.set(p.id, { kind: "permission", reqId: p.id, chatId: ownerChat(), messageIds: msgs.map((m) => m.message_id) });
}

function questionText(q) {
  let t = `❓ <b>${esc(q.header || "Question")}</b>\n${esc(q.question)}`;
  if (q.multiple) t += "\n\n<i>Select all that apply.</i>";
  t += "\n\n<i>Tap an option — or just type your answer.</i>";
  return t;
}

async function onQuestionAsked(p) {
  const ask = {
    kind: "question",
    reqId: p.id,
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

async function onMessageUpdated({ sessionID, info }) {
  if (info.role !== "assistant") return;
  if (!info.time?.completed) return;
  if (sentMessages.has(info.id)) return;
  sentMessages.add(info.id);
  if (sentMessages.size > 500) sentMessages.clear();
  const chatId = ownerChat();
  try {
    const full = await oc.getMessage(sessionID, info.id);
    if (info.error) {
      const msg = typeof info.error === "string" ? info.error : JSON.stringify(info.error);
      await push(chatId, `❌ <b>Error</b>\n${esc(msg.slice(0, 800))}`);
      expectingText.delete(sessionID);
      return;
    }
    const texts = (full.parts || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    if (texts.trim()) {
      await push(chatId, mdToHtml(texts));
      expectingText.delete(sessionID);
    }
  } catch (e) {
    console.error("[ev] message fetch failed:", e.message);
  }
}

const QUIET_TOOLS = new Set(["read", "glob", "grep", "question", "todowrite", "todoread"]);

async function onPartUpdated({ part }) {
  if (part.type !== "tool" || QUIET_TOOLS.has(part.tool)) return;
  const st = part.state?.status;
  if (st === "running") {
    if (toolSeen.has(part.id)) return;
    toolSeen.add(part.id);
    if (toolSeen.size > 1000) toolSeen.clear();
    const arg = toolArg(part);
    await push(ownerChat(), `🔨 <code>${esc(part.tool)}</code>${arg ? " — " + esc(arg) : ""}`);
  } else if (st === "error") {
    if (toolSeen.has(part.id + ":err")) return;
    toolSeen.add(part.id + ":err");
    const errTxt = part.state?.error || "failed";
    await push(ownerChat(), `⚠️ <code>${esc(part.tool)}</code> — ${esc(String(errTxt).slice(0, 150))}`);
  }
}

async function onSessionStatus({ sessionID, status }) {
  if (status.type !== "retry") {
    retryNotified.delete(sessionID);
    return;
  }
  if (retryNotified.has(sessionID)) return;
  retryNotified.add(sessionID);
  await push(ownerChat(), `⚠️ Provider retry (attempt ${status.attempt}): ${esc((status.message || "").slice(0, 200))}`);
}

async function onSessionIdle({ sessionID }) {
  if (expectingText.has(sessionID)) {
    expectingText.delete(sessionID);
    await push(ownerChat(), "✅ Finished (no text output).");
  }
}

async function announcePending() {
  let perms = [];
  let questions = [];
  try {
    perms = await oc.pendingPermissions();
    questions = await oc.pendingQuestions();
  } catch {}
  for (const p of perms) if (!pendingAsks.has(p.id)) await onPermissionAsked(p);
  for (const q of questions) if (!pendingAsks.has(q.id)) await onQuestionAsked(q);
}

function ownerOnly() {
  return async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid === undefined || String(uid) !== OWNER) return;
    if (ctx.chat && state.get().chatId !== ctx.chat.id) state.set({ chatId: ctx.chat.id });
    await next();
  };
}

async function sessionsList(chatId) {
  const sessions = (await oc.listSessions())
    .filter((s) => !s.parentID)
    .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
    .slice(0, 15);
  state.set({ lastSessionList: sessions.map((s) => s.id) });
  const active = state.get().activeSessionId;
  const lines = sessions.map(
    (s, i) => `${s.id === active ? "▶️" : `<b>${i + 1}.</b>`} ${esc((s.title || "untitled").slice(0, 60))}\n      <i>${esc(s.id)}</i>`
  );
  await push(chatId, lines.length ? lines.join("\n") : "No sessions yet — send a message or /new");
}

function registerCommands() {
  const helpText = [
    "<b>TeleCode</b> — opencode on Telegram",
    "",
    "Type any message → it goes to the active opencode session.",
    "When the session needs approval or asks a question, it appears here with buttons.",
    "",
    "/new &lt;title&gt; — start a fresh session",
    "/sessions — list recent sessions",
    "/switch &lt;n&gt; — switch to session n",
    "/abort — stop the current task",
    "/pending — show pending approvals/questions",
    "/status — bridge status"
  ].join("\n");

  bot.command("start", (ctx) => push(ctx.chat.id, helpText));
  bot.command("help", (ctx) => push(ctx.chat.id, helpText));

  bot.command("new", async (ctx) => {
    const title = (ctx.match || "").trim() || `tg ${new Date().toISOString().slice(0, 16)}`;
    const s = await oc.createSession(title.slice(0, 80));
    state.set({ activeSessionId: s.id });
    await push(ctx.chat.id, `🆕 Session started: <b>${esc(title.slice(0, 80))}</b>\n<code>${esc(s.id)}</code>`);
  });

  bot.command("sessions", async (ctx) => sessionsList(ctx.chat.id));

  bot.command("switch", async (ctx) => {
    const n = parseInt((ctx.match || "").trim(), 10);
    const list = state.get().lastSessionList;
    if (!n || n < 1 || n > list.length) {
      await push(ctx.chat.id, "Usage: /switch &lt;n&gt; — run /sessions first.");
      return;
    }
    const sid = list[n - 1];
    state.set({ activeSessionId: sid });
    await push(ctx.chat.id, `🔄 Switched to <code>${esc(sid)}</code>`);
  });

  bot.command("abort", async (ctx) => {
    const sid = state.get().activeSessionId;
    if (!sid) {
      await push(ctx.chat.id, "No active session.");
      return;
    }
    try {
      await oc.abortSession(sid);
      expectingText.delete(sid);
      await push(ctx.chat.id, "🛑 Abort sent.");
    } catch (e) {
      await push(ctx.chat.id, `⚠️ Abort failed: ${esc(e.message)}`);
    }
  });

  bot.command("status", async (ctx) => {
    const sid = state.get().activeSessionId;
    let statusLine = "no active session";
    let title = "-";
    if (sid) {
      try {
        const sts = await oc.sessionStatuses();
        const st = sts[sid];
        statusLine = st ? st.type : "idle";
        const s = (await oc.listSessions()).find((x) => x.id === sid);
        title = s?.title || "-";
      } catch {}
    }
    let version = "?";
    try {
      version = (await oc.api("GET", "/global/health")).version;
    } catch {}
    await push(
      ctx.chat.id,
      `🟢 TeleCode bridge\nopencode: <code>${esc(version)}</code>\nsession: <b>${esc(title)}</b>\n<code>${esc(sid || "-")}</code>\nstatus: <b>${esc(statusLine)}</b>\npending asks: ${pendingAsks.size}`
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
        await oc.replyPermission(reqId, choice);
        const label = choice === "once" ? "approved (once)" : choice === "always" ? "approved (always)" : "denied";
        await ctx.editMessageText(`${choice === "reject" ? "❌" : "✅"} Permission ${label}.`).catch(() => {});
        pendingAsks.delete(reqId);
        await ctx.answerCallbackQuery({ text: `Permission ${choice}` });
      } else if (data.startsWith("q|")) {
        const [, reqId, qi, oi] = data.split("|");
        const ask = pendingAsks.get(reqId);
        if (!ask) {
          await ctx.answerCallbackQuery({ text: "Already answered" });
          return;
        }
        const q = ask.questions[Number(qi)];
        const label = q?.options?.[Number(oi)]?.label ?? `option ${oi}`;
        ask.answers[Number(qi)] = label;
        await ctx.editMessageText(`✔️ ${esc(label)}`).catch(() => {});
        if (ask.answers.every((a) => a !== null)) {
          await oc.replyQuestion(reqId, ask.answers);
          pendingAsks.delete(reqId);
          await ctx.answerCallbackQuery({ text: "Answer sent" });
        } else {
          const done = ask.answers.filter((a) => a !== null).length;
          await ctx.answerCallbackQuery({ text: `Saved (${done}/${ask.answers.length})` });
        }
      } else if (data.startsWith("qrej|")) {
        const [, reqId] = data.split("|");
        pendingAsks.delete(reqId);
        await oc.rejectQuestion(reqId).catch(() => {});
        await ctx.editMessageText("🚫 Question skipped.").catch(() => {});
        await ctx.answerCallbackQuery({ text: "Skipped" });
      } else {
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

    const openQuestion = [...pendingAsks.values()].find(
      (a) => a.kind === "question" && a.chatId === chatId && a.answers.some((x) => x === null)
    );
    if (openQuestion) {
      const qi = openQuestion.answers.findIndex((x) => x === null);
      openQuestion.answers[qi] = text;
      if (openQuestion.answers.every((x) => x !== null)) {
        try {
          await oc.replyQuestion(openQuestion.reqId, openQuestion.answers);
          pendingAsks.delete(openQuestion.reqId);
          await push(chatId, `📩 Answer sent: <b>${esc(text.slice(0, 100))}</b>`);
        } catch (e) {
          await push(chatId, `⚠️ Could not submit answer: ${esc(e.message)}`);
        }
      } else {
        const done = openQuestion.answers.filter((x) => x !== null).length;
        await push(chatId, `📩 Saved (${done}/${openQuestion.answers.length}) — tap an option or type for the rest.`);
      }
      return;
    }

    await sendPrompt(chatId, text);
  });
}

async function main() {
  state.load();
  state.set({ ownerId: Number(OWNER) });

  const { health, adopted } = await oc.ensureServer();
  oc.startWatchdog();
  console.log(`[bridge] opencode ${health.version} at ${oc.BASE} (${adopted ? "adopted" : "spawned"})`);

  bot = new Bot(TOKEN);
  bot.catch((err) => console.error("[tg] bot error:", err.error?.message || err.message));
  bot.use(ownerOnly());
  registerCommands();
  registerCallbacks();
  registerMessages();

  await bot.init();
  await bot.api.setMyCommands([
    { command: "new", description: "Start a new session" },
    { command: "sessions", description: "List recent sessions" },
    { command: "switch", description: "Switch to session n" },
    { command: "abort", description: "Stop the current task" },
    { command: "pending", description: "Show pending approvals/questions" },
    { command: "status", description: "Bridge status" },
    { command: "help", description: "How to use" }
  ]);

  oc.watchEvents(handleEvent);

  await push(ownerChat(), `✅ TeleCode bridge is running.\nopencode <code>${esc(health.version)}</code> — workspace <code>${esc(process.env.WORKSPACE_DIR)}</code>\n\nType anything to start a session, or /help.`);
  await announcePending();

  await bot.start({
    onStart: () => console.log("[bridge] telegram polling started")
  });
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
