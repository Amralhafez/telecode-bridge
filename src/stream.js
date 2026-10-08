const { mdToHtml, splitHtml } = require("./format");

const MIN_EDIT_MS = 1200;
const ACTIVITY_EDIT_MS = 1000;
const TAIL = 3800;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function editSafe(bot, chatId, messageId, text, extra = {}) {
  try {
    await bot.api.editMessageText(chatId, messageId, text, extra);
    return true;
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("message is not modified")) return true;
    const retryAfter = e.retry_after || (e.error && e.error.retry_after);
    if (retryAfter) {
      await sleep(retryAfter * 1000);
      try {
        await bot.api.editMessageText(chatId, messageId, text, extra);
        return true;
      } catch {}
    }
    return false;
  }
}

class TurnView {
  constructor(bot, chatId) {
    this.bot = bot;
    this.chatId = chatId;
    this.activityId = null;
    this.replyId = null;
    this.tools = [];
    this.textParts = new Map();
    this.textPartIds = new Set();
    this.lastActivityEdit = 0;
    this.lastReplyEdit = 0;
    this.activityTimer = null;
    this.replyTimer = null;
    this.closed = false;
  }

  async ensureActivity() {
    if (this.activityId || this.closed) return;
    try {
      const m = await this.bot.api.sendMessage(this.chatId, "🧠 Thinking…");
      this.activityId = m.message_id;
    } catch (e) {
      console.error("[stream] activity send failed:", e.message);
    }
  }

  activityText() {
    const shown = this.tools.slice(-3);
    const extra = this.tools.length - shown.length;
    const lines = [`🛠 ${this.tools.length} tool call${this.tools.length === 1 ? "" : "s"}`];
    for (const t of shown) lines.push(`🔨 ${t}`);
    if (extra > 0) lines.push(`… +${extra} earlier`);
    return lines.join("\n");
  }

  addTool(line) {
    this.tools.push(line);
    this.flushActivity();
  }

  flushActivity() {
    if (!this.activityId || this.closed) return;
    const now = Date.now();
    const since = now - this.lastActivityEdit;
    if (since < ACTIVITY_EDIT_MS) {
      if (!this.activityTimer) {
        this.activityTimer = setTimeout(() => {
          this.activityTimer = null;
          this.flushActivity();
        }, ACTIVITY_EDIT_MS - since);
      }
      return;
    }
    this.lastActivityEdit = now;
    editSafe(this.bot, this.chatId, this.activityId, this.activityText()).catch(() => {});
  }

  notePart(part) {
    if (part.type === "text" && part.id) this.textPartIds.add(part.id);
  }

  addDelta(partId, field, delta) {
    if (field !== "text" || !this.textPartIds.has(partId)) return;
    const cur = this.textParts.get(partId) || "";
    this.textParts.set(partId, cur + delta);
    this.scheduleReply();
  }

  liveText() {
    return [...this.textParts.values()].join("");
  }

  scheduleReply() {
    if (this.closed) return;
    const now = Date.now();
    const since = now - this.lastReplyEdit;
    if (since < MIN_EDIT_MS) {
      if (!this.replyTimer) {
        this.replyTimer = setTimeout(() => {
          this.replyTimer = null;
          this.flushReply();
        }, MIN_EDIT_MS - since);
      }
      return;
    }
    this.flushReply();
  }

  flushReply() {
    const text = this.liveText();
    if (!text || this.closed) return;
    const now = Date.now();
    if (now - this.lastReplyEdit < MIN_EDIT_MS) {
      this.scheduleReply();
      return;
    }
    this.lastReplyEdit = now;
    (async () => {
      try {
        if (!this.replyId) {
          const m = await this.bot.api.sendMessage(this.chatId, text.slice(-TAIL));
          this.replyId = m.message_id;
        } else {
          await editSafe(this.bot, this.chatId, this.replyId, text.slice(-TAIL));
        }
      } catch (e) {
        console.error("[stream] reply view failed:", e.message);
      }
    })();
  }

  async resetForNextMessage() {
    this.textParts.clear();
    this.replyId = null;
    this.lastReplyEdit = 0;
    if (this.replyTimer) {
      clearTimeout(this.replyTimer);
      this.replyTimer = null;
    }
  }

  async finalize(fullText) {
    this.closed = true;
    if (this.replyTimer) {
      clearTimeout(this.replyTimer);
      this.replyTimer = null;
    }
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    const text = (fullText || "").trim() ? fullText : this.liveText();
    const chunks = text.trim() ? splitHtml(mdToHtml(text)) : [];

    if (!chunks.length) {
      if (this.replyId) {
        await editSafe(this.bot, this.chatId, this.replyId, "✅ (no text output)").catch(() => {});
      }
      return;
    }

    let firstSent = false;
    if (this.replyId) {
      firstSent = await editSafe(this.bot, this.chatId, this.replyId, chunks[0], { parse_mode: "HTML" });
    }
    const start = firstSent ? 1 : 0;
    for (let i = start; i < chunks.length; i++) {
      try {
        await this.bot.api.sendMessage(this.chatId, chunks[i], { parse_mode: "HTML" });
      } catch (e) {
        try {
          await this.bot.api.sendMessage(this.chatId, chunks[i].replace(/<[^>]+>/g, ""));
        } catch {}
      }
    }
  }
}

module.exports = { TurnView, editSafe };
