#!/usr/bin/env node
// Minimal MCP stdio server exposing one tool: `approve`.
// Claude Code calls it (via --permission-prompt-tool) whenever a tool needs
// permission. We forward the request to the running TeleCode bridge over
// local HTTP, which asks the owner on Telegram and returns the decision.
// Only stdout carries JSON-RPC; everything else goes to stderr.
const APPROVE_URL = process.env.TELECODE_APPROVE_URL || "";
const SECRET = process.env.TELECODE_SECRET || "";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function log(...a) {
  process.stderr.write("[claude-mcp] " + a.join(" ") + "\n");
}

const TOOL = {
  name: "approve",
  description: "Ask the TeleCode owner (via Telegram) to allow or deny a tool call.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" }
    },
    required: ["tool_name", "input"]
  }
};

async function askOwner(args) {
  if (!APPROVE_URL) return { behavior: "deny", message: "TeleCode approval endpoint not configured." };
  try {
    const res = await fetch(APPROVE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET, tool_name: args.tool_name, input: args.input, tool_use_id: args.tool_use_id })
    });
    const j = await res.json();
    if (j && j.behavior) return j;
    return { behavior: "deny", message: "No decision from TeleCode." };
  } catch (e) {
    log("approve request failed:", e.message);
    return { behavior: "deny", message: "TeleCode unreachable: " + e.message };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "telecode", version: "1.0.0" }
      }
    });
    return;
  }
  if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) return;
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name !== "approve") {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
      return;
    }
    const decision = await askOwner(args);
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(decision) }] }
    });
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((e) => log("handler error:", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log("ready");
