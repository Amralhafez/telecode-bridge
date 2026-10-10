<div align="center">

# 🤖 TeleCode

**Your AI coding agent, in your pocket — drive [opencode](https://opencode.ai) from Telegram.**

Send a message to your bot and it becomes a prompt to an opencode session running on your machine: replies stream back live, approvals and questions arrive as tappable buttons, and a full button menu puts git, files, branches, voice and more one tap away.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Built with grammY](https://img.shields.io/badge/Built%20with-grammY-005571)](https://grammy.dev)
[![Powered by opencode](https://img.shields.io/badge/Powered%20by-opencode-black)](https://opencode.ai)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![Platform](https://img.shields.io/badge/Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#requirements)

</div>

---

> [!NOTE]
> **Personal by design.** Only the one Telegram user you pair with can talk to the bot — everyone else is ignored.

## ✨ Why TeleCode

Your coding agent usually lives in a terminal. TeleCode lets you kick off tasks, answer its questions, review diffs, commit, push, and open a PR — all from your phone, while the real work runs on your own machine against your own repos.

## 🎬 In action

```
you  ▸  /new
bot  ◂  🆕 New session — tell me what you want to do 👇
you  ▸  add a dark-mode toggle to the settings page
bot  ◂  🧠 Thinking…  🛠 4 tool calls · ⏱ 12s
bot  ◂  🔐 Permission needed:  bash  ·  npm run build
        [ ✅ Once ]  [ 🔁 Always ]  [ ❌ Deny ]
bot  ◂  Added a ThemeToggle component and wired it to localStorage…
bot  ◂  ✅ Done · 3 change(s)   [ ▶️ Continue ] [ 🔀 Git ] [ 🏠 Menu ]
you  ▸  (taps 🔀 Git → 📥 Commit & push)
bot  ◂  🚀 Pushed feature/dark-mode.   [ 🔀 Open PR ] [ 🐙 CI ]
```

> 💡 Add a screen recording or screenshots here before sharing — `docs/demo.gif`.

## 🚀 Features

**Core**
- 💬 **Live streaming** — assistant text and tool activity update in place, with an elapsed-time indicator.
- 🔐 **Approvals & questions** — permission requests and agent questions become inline buttons (or just type your answer).
- 🧭 **One morphing menu** — `/menu` is a single message that navigates in place, so the chat stays clean.
- 📁 **Multi-repo** — register several projects and switch between them; each gets its own opencode server.
- 🖼 **Media & voice** — send photos (vision), files, or a voice note that gets transcribed into a prompt.

**Git & GitHub**
- 📥 One-tap **commit & push** with an auto-generated message, full-diff export, and turn-level revert.
- 🌿 **Branch** switch / create, and an **Open PR** button after every push.
- 🐙 **GitHub CLI** integration: CI status, list PRs, create issues.

**Power tools**
- ⚡ **Templates** — quick prompts (run tests, fix lint, review changes).
- 📂 **File browser** — navigate, view, download, or "ask the agent about this file".
- 🔎 **Grep** the workspace · 🖥 **`/sh`** run a shell command (owner-only, confirmed).
- ⏰ **Scheduler** — recurring prompts (`daily 09:00`, `every 2h`).
- 💰 **Budget guard** — auto-aborts a session when its cost crosses your limit.
- 🌙 **Quiet hours** · 🤖 **YOLO mode** (auto-approve) · 👥 **team** allowlist.

**Reliability**
- 🛟 Self-healing watchdog restarts opencode if it dies (and pings you), plus a lockfile guard.
- 🩺 `/doctor` self-check and `/logs` tail, straight to Telegram.

## 📋 Requirements

- [Node.js](https://nodejs.org) **18+**
- [opencode](https://opencode.ai) on your `PATH` (`opencode --version` works)
- A Telegram bot token and your numeric Telegram user id

Runs on **Linux, macOS, and Windows**. GitHub features need the optional [`gh` CLI](https://cli.github.com); voice needs any OpenAI-compatible speech-to-text endpoint.

## ⚡ Quick start

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/telecode-bridge.git
cd telecode-bridge
npm install
npm run setup      # interactive — writes your .env
npm start
```

`npm run setup` asks for:

1. **Bot token** — from [@BotFather](https://t.me/BotFather).
2. **Owner id** — *optional*: leave empty and the first person to message the bot (you, by tapping **Start**) is paired automatically. No `@userinfobot` step needed.
3. **Workspace dir** — the project opencode should work on.
4. **opencode host/port** — defaults (`127.0.0.1:4096`) are fine.

Then open your bot in Telegram, tap **Start**, and send `/menu`.

## 🎛 Commands

| Command | Does |
| --- | --- |
| *(any text)* | Prompt the active session (streamed) |
| `/menu` | The button menu for everything |
| `/new` · `/sessions` · `/switch` | New session (asks what to do) · list · switch |
| `/abort` · `/cancel` · `/revert` | Stop task · drop a prompt · undo last turn |
| `/repo` · `/branch` · `/mode` · `/agent` · `/model` | Switch project / branch / plan↔build / agent / model |
| `/commit` · `/push` · `/diff` | Git from your pocket |
| `/ci` · `/prs` · `/issue` | GitHub CI / pull requests / new issue |
| `/files` · `/grep` · `/sh` | Browse files · search · run a shell command |
| `/templates` · `/schedule` | Quick prompts · recurring runs |
| `/todos` · `/cost` · `/usage` | Session todos · cost · usage dashboard |
| `/yolo` · `/budget` · `/dnd` · `/team` | Auto-approve · cost guard · quiet hours · access |
| `/doctor` · `/logs` · `/status` · `/export` | Health check · logs · status · transcript |

Photos, documents, and voice notes are forwarded to the session too.

## 🔄 Running in the background

**PM2 (any OS):**
```bash
npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
```

**Watchdog (no deps):** run `npm run watchdog` from cron (Linux/macOS) or Task Scheduler (Windows) every few minutes — it starts the bridge only if it isn't already alive, so it both launches and self-heals.

## 🐳 Docker (optional)

Works fine without Docker, but a compose file is included:
```bash
cp .env.example .env   # fill it in
docker compose up -d
```
Mount your project at `/workspace` and set `WORKSPACE_DIR=/workspace`.

## 🗺 Architecture

```
Telegram  ──►  TeleCode (grammY bot)  ──►  opencode serve (HTTP + SSE)
   ▲                   │                            │
   └──── streamed ─────┴──────── events/replies ────┘
```

The bridge talks to opencode's local HTTP API, subscribes to its event stream, and relays everything to/from your chat. State (active repo, sessions, model, agent, schedules…) lives in `state.json`.

## 🔐 Security

- `.env`, `state.json`, `logs/`, and `bridge.lock` are gitignored — your token never gets committed.
- Only the configured owner (plus anyone you explicitly `/team add`) is served.
- `/sh` and destructive git actions require an explicit confirmation tap.
- `/repo add` writes a default `opencode.json` (bash set to "ask") only if the project has none.

## 🤝 Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is small, dependency-light JavaScript (`grammy` + `dotenv`), organized as focused modules under `src/`.

## 📜 License

[MIT](LICENSE) © Amr Alhafez

## 🙏 Acknowledgements

Built on [opencode](https://opencode.ai) and [grammY](https://grammy.dev).
