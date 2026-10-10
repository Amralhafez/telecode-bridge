# Contributing to TeleCode

Thanks for your interest! Contributions of all sizes are welcome.

## Getting set up

```bash
git clone https://github.com/Amralhafez/telecode-bridge.git
cd telecode-bridge
npm install
npm run setup   # creates your .env (use a test bot)
npm start
```

You'll need Node.js 18+ and [opencode](https://opencode.ai) on your `PATH`.

## Project layout

```
src/
  index.js    bot wiring: commands, callbacks, menu, event handlers
  oc.js       opencode server manager (spawn/adopt, health, SSE events)
  state.js    persisted state (state.json) + migrations
  stream.js   live "turn view" that streams edits back to Telegram
  format.js   markdown → Telegram HTML, diff/todo/cost formatting
  media.js    Telegram file download helpers
  stt.js      speech-to-text (voice notes)
  git.js      git helpers (status, commit, push, branches, PR url)
  gh.js       GitHub CLI wrapper (CI, PRs, issues)
  files.js    safe workspace file browsing + search
scripts/setup.js   interactive .env wizard
```

## Guidelines

- **Keep it dependency-light.** Runtime deps are just `grammy` and `dotenv`; prefer Node built-ins.
- **All user-facing strings are English.**
- **Match the style:** 2-space indent, `camelCase`, small focused functions. Menu panels are built as `*View()` helpers returning `{ html, kb }` so both commands and buttons can reuse them.
- **Never log or commit secrets.** `.env`, `state.json`, and `logs/` are gitignored — keep it that way.
- Test your change against a real bot before opening a PR, and note what you tried.

## Pull requests

1. Fork and branch from `main` (`git checkout -b feat/my-thing`).
2. Keep commits focused with clear messages (`feat:`, `fix:`, `docs:`, `chore:`).
3. Open a PR describing the change and how you verified it.

## Reporting bugs

Open an issue with your OS, Node version, opencode version (`/status` in the bot), and the relevant lines from `/logs`.
