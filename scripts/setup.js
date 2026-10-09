#!/usr/bin/env node
// Interactive setup — writes a .env file. Cross-platform, no dependencies.
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) =>
  new Promise((res) => {
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res((a || "").trim() || def || ""));
  });

function parseExisting() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

async function main() {
  console.log("\n  TeleCode bridge — setup\n  " + "-".repeat(28));
  if (fs.existsSync(ENV_PATH)) {
    const go = await ask("An .env already exists. Overwrite it? (y/N)", "N");
    if (!/^y/i.test(go)) {
      console.log("Keeping the existing .env. Nothing changed.");
      rl.close();
      return;
    }
  }
  const cur = parseExisting();

  console.log("\n1) Create a bot with @BotFather on Telegram and paste its token.");
  const token = await ask("TELEGRAM_BOT_TOKEN", cur.TELEGRAM_BOT_TOKEN);

  console.log("\n2) Your Telegram user id — ONLY this person may use the bot.");
  console.log("   Leave this EMPTY to auto-pair: the first person who messages");
  console.log("   the bot (you, by tapping Start) is locked in as the owner.");
  console.log("   Or paste your numeric id from @userinfobot to set it now.");
  const owner = await ask("TELEGRAM_OWNER_ID (empty = auto-pair)", cur.TELEGRAM_OWNER_ID);

  console.log("\n3) Absolute path of the project opencode should work on.");
  const workspace = await ask("WORKSPACE_DIR", cur.WORKSPACE_DIR || process.cwd());

  console.log("\n4) opencode server (press Enter to accept defaults).");
  const host = await ask("OPENCODE_HOST", cur.OPENCODE_HOST || "127.0.0.1");
  const port = await ask("OPENCODE_PORT", cur.OPENCODE_PORT || "4096");
  const password = await ask("OPENCODE_SERVER_PASSWORD (optional)", cur.OPENCODE_SERVER_PASSWORD || "");

  const content = [
    `TELEGRAM_BOT_TOKEN=${token}`,
    `TELEGRAM_OWNER_ID=${owner}`,
    `WORKSPACE_DIR=${workspace}`,
    `OPENCODE_HOST=${host}`,
    `OPENCODE_PORT=${port}`,
    `OPENCODE_SERVER_PASSWORD=${password}`,
    ""
  ].join("\n");

  fs.writeFileSync(ENV_PATH, content);
  rl.close();

  console.log(`\n✓ Wrote ${ENV_PATH}`);
  if (!token) {
    console.log("⚠ TELEGRAM_BOT_TOKEN is empty — the bridge won't start until it's set.");
  } else if (!owner) {
    console.log("ℹ No owner set — auto-pairing is ON. Run `npm start`, then open your");
    console.log("  bot in Telegram and tap Start to claim ownership.");
  }
  console.log("\nNext:  npm start\n");
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});
