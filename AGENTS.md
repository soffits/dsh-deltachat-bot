# Maintainer notes

## Layout

- `index.js` → `src/app.js`: the bot row (`deltachat-bot`). `createBridge(ctx, config, core)` holds the runtime: the Delta Chat profile, incoming messages, the chat → session map, turn delivery, the `deltachatChats` service and the spool. `apply` passes the real core; tests pass a fake one.
- `src/core.js`: everything that talks to `deltachat-rpc-server` (spawning it, creating the profile and relays, the invite, fingerprints, the IO watchdog).
- `src/sessions.js`: DSH session helpers (create, resume, prompt, steer, record without a turn, titles, workspaces, access modes).
- `src/commands.js`: chat commands. `src/prompts.js`: agent questions and tool approvals answered from a chat.
- `src/inbound.js`: one Delta Chat message → prompt text and attachments. `src/text.js`: answers, Markdown → plain text, splitting.
- `src/identity.js`: key fingerprints and the sender line. `src/state.js`: `state.json`. `src/spool.js`: the request spool shared with `bin/dsh-deltachat.js`.
- `src/models.js` and `src/voice.js` come from soffits/dsh-telegram-bot; keep them in step with it.
- `tools.js`: the `deltachat-bot-tools` row (`deltachat_send`).

## Checks

`npm test` (keep `--import ./test/home.js`: it points `DSH_HOME` at a temp directory), `npm run check`. `npm run e2e` uses real relays and creates throwaway accounts; run it after a core update or a change in how messages are sent or read, not as part of every change.

## Working on the project

- Everything in the repo (code, docs, commits) is English.
- Ordinary implementation choices are yours: decide, write the choice and its one-line reason in `docs/decisions.md` (replacing any line it supersedes), and mention it in your report.
- If a requested approach looks weaker than an alternative, say so with the reason before building it.
- Report each state separately: implemented, tested (which checks, which real run), committed, pushed, CI.
- Before writing any non-trivial component, look for maintained libraries and better approaches first, and record why in `docs/decisions.md`.
- The `deltachatChats.send({ to, text, files, from, replyTo, reaction })` contract and the `retryable: false` marker are public API for other plugins; change them only with a major version.
- Split a file by responsibility before it grows past about 500 lines. No dead code or bare `TODO`.
- README is for users; notes for maintainers go here or in `docs/`.

## Git and releases

- Conventional Commits, one-line subjects. Squash merges; delete the branch when merging.
- Releases: move `Unreleased` in `CHANGELOG.md` under the new version, bump `package.json`, merge, wait for green CI on `main`, then `npm publish`. Bump `@deltachat/stdio-rpc-server` and `@deltachat/jsonrpc-client` together and run `npm run e2e` before releasing a core update.
