# TeleCode bridge

Drive [opencode](https://opencode.ai) coding sessions from **Telegram**. Send a
message to your bot and it becomes a prompt to an opencode session running on
your machine — with replies streamed back live, approval and question prompts as
inline buttons, multi-repo switching, and image/file uploads.

> Personal tool: only the one Telegram user you configure can talk to the bot.

## Features

- 💬 **Live streaming** — assistant text and tool activity update in place as it works.
- 🔐 **Approvals & questions** — permission requests and agent questions arrive as tappable buttons (or just type your answer).
- 📁 **Multi-repo** — register several projects and switch between them; each gets its own opencode server.
- 🧠 **Model & agent control** — `/model`, `/agent`, `/mode` (plan ↔ build).
- 🖼 **Media** — send photos (vision) and files straight into the session.
- 🛟 **Self-healing** — a watchdog restarts the opencode server if it goes down; a lockfile prevents double starts.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- [opencode](https://opencode.ai) installed and on your `PATH` (`opencode --version` should work)
- A Telegram bot token and your numeric Telegram user id

Works on **Linux, macOS, and Windows**.

## Setup

```bash
git clone https://github.com/your-username/telecode-bridge.git
cd telecode-bridge
npm install
npm run setup      # interactive — writes your .env
npm start
```

`npm run setup` asks for four things:

1. **Bot token** — create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. **Your Telegram id** — get it from [@userinfobot](https://t.me/userinfobot). Only this id may use the bridge.
3. **Workspace dir** — absolute path of the project opencode should work on.
4. **opencode host/port** — defaults (`127.0.0.1:4096`) are fine for local use.

Prefer to do it by hand? Copy `.env.example` to `.env` and fill it in.

When it starts you'll get a `✅ TeleCode is running` message in Telegram. Send any
text to prompt the active session, or `/help` for the full command list.

## Commands

| Command | What it does |
| --- | --- |
| *(any text)* | Prompt the active session (streamed live) |
| `/new <title>` | Start a fresh session |
| `/sessions` · `/switch <n>` | List / switch sessions |
| `/abort` | Stop the current task |
| `/repo` · `/repo <name>` | List / switch repos |
| `/repo add <name> <path>` | Register another project |
| `/repo remove <name>` | Unregister a repo |
| `/model [provider/model \| list <q>]` | Show / set / browse models |
| `/agent [name]` · `/mode` | Switch agent / plan↔build |
| `/diff` · `/todos` · `/cost` | Session changes / todos / token cost |
| `/share` · `/revert` | Share URL / undo last turn |
| `/pending` · `/status` | Pending approvals / bridge status |
| `/menu` | Button menu for everything |
| `/commit [msg]` · `/push` | Git commit (auto message) and push |
| `/yolo` | Toggle auto-approval of permission requests |
| `/files` | Browse & download workspace files |
| `/templates` | Quick-prompt buttons (tests, lint, review…) |
| `/schedule add <spec> \| <prompt>` | Recurring runs (`daily HH:MM`, `every 30m`, `every 2h`) |
| `/export` | Session transcript as Markdown |
| `/clone <url> [name]` | Clone a git repo and register it |
| `/budget <usd>` | Alert when a session's cost crosses a limit |
| `/team add\|remove <id>` | Let other Telegram users in (owner only) |

Photos and documents with a caption are forwarded to the session too, and
**voice notes are transcribed** and sent as prompts when STT is configured.

## Voice notes (optional)

Set `STT_API_KEY` in `.env` to turn voice messages into prompts. Any
OpenAI-compatible `/audio/transcriptions` endpoint works — override
`STT_API_URL` and `STT_MODEL` to point at a different provider.

## Running it in the background

**Any OS — PM2 (recommended):**

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

**Watchdog (no extra deps):** run `npm run watchdog` from cron (Linux/macOS) or
Task Scheduler (Windows) every few minutes — it starts the bridge only if it
isn't already alive.

**Launch scripts:** `./start-bridge.sh` (Linux/macOS) or `start-bridge.cmd`
(Windows) run from their own folder and log to `logs/`.

## Docker (optional)

The bridge runs fine without Docker, but a compose file is provided if you want
it containerized:

```bash
cp .env.example .env   # fill it in
docker compose up -d
```

Mount your project at `/workspace` (see `docker-compose.yml`) and set
`WORKSPACE_DIR=/workspace` in `.env`.

## How it works

```
Telegram  ──►  telecode-bridge (grammY bot)  ──►  opencode serve (HTTP + SSE)
   ▲                     │                                  │
   └───── streamed ──────┴──────── events / replies ────────┘
```

The bridge talks to opencode's local HTTP API, subscribes to its event stream,
and relays everything to/from your Telegram chat. State (active repo, sessions,
model, agent) is persisted in `state.json`.

## Security notes

- `.env`, `state.json`, `logs/`, and `bridge.lock` are gitignored — your token
  never gets committed. **Don't share your `.env`.**
- Only the configured `TELEGRAM_OWNER_ID` is served; everyone else is ignored.
- `/repo add` writes a default `opencode.json` (bash commands set to "ask") into
  a project only if one isn't already there.

## License

[MIT](LICENSE) © Amr Alhafez
