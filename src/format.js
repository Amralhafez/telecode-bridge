const LIMIT = 3900;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToHtml(md) {
  const blocks = [];
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return text;
}

function splitHtml(html) {
  if (html.length <= LIMIT) return [html];
  const parts = [];
  let rest = html;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf("\n", LIMIT);
    if (cut < LIMIT * 0.4) cut = LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

const STATUS_ICON = { added: "🟢", modified: "🟡", deleted: "🔴" };
const TODO_ICON = { pending: "⬜", in_progress: "🔵", completed: "✅", cancelled: "🚫" };

function fmtDiff(diffs, maxFiles = 30) {
  if (!Array.isArray(diffs) || !diffs.length) return "No file changes in this session.";
  let add = 0;
  let del = 0;
  const lines = diffs.slice(0, maxFiles).map((d) => {
    add += d.additions || 0;
    del += d.deletions || 0;
    return `${STATUS_ICON[d.status] || "•"} ${esc(d.path)}  <b>+${d.additions || 0}</b> −${d.deletions || 0}`;
  });
  if (diffs.length > maxFiles) lines.push(`… and ${diffs.length - maxFiles} more files`);
  lines.push("", `<b>Total: +${add} −${del} across ${diffs.length} file${diffs.length === 1 ? "" : "s"}</b>`);
  return lines.join("\n");
}

function fmtTodos(todos) {
  if (!Array.isArray(todos) || !todos.length) return "No todos in this session.";
  return todos
    .map((t) => `${TODO_ICON[t.status] || "⬜"} ${esc(t.content)} <i>(${esc(t.priority || "medium")})</i>`)
    .join("\n");
}

function fmtCost(s) {
  if (!s) return "Session not found.";
  const t = s.tokens || {};
  const c = s.cost || 0;
  return [
    `💰 Cost: <b>$${c.toFixed(4)}</b>`,
    `tokens: ${t.input || 0} in / ${t.output || 0} out / ${t.reasoning || 0} reasoning`,
    `cache: ${t.cache?.read || 0} read / ${t.cache?.write || 0} write`
  ].join("\n");
}

module.exports = { mdToHtml, splitHtml, esc, fmtDiff, fmtTodos, fmtCost };
