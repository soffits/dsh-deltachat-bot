# Decisions

## Building blocks

- Own plugin on the official `@deltachat/stdio-rpc-server` + `@deltachat/jsonrpc-client` (MPL-2.0, maintained with the chatmail core). No DSH Delta Chat plugin existed; the other bridges looked at (nanoclaw's `add-deltachat` adapter, hermes-deltachat, deltabot-cli, dcbot-cli) target other hosts or wrap the same library. Their practice was adopted where it fits: `bot=1`, `addTransportFromQr("dcaccount:<relay>")` per relay (deltabot-cli), an IO watchdog (nanoclaw).
- The RPC server is spawned in `src/core.js`, not with `startDeltaChat`: that helper throws from the child's `exit`/`error` handlers, which would crash the Host process. An unexpected exit is reported and the bot restarts with backoff (5 s doubling to 5 min). The server also exits by itself when the Host dies (its stdin closes).
- Both `@deltachat` packages are pinned to the same exact version; Dependabot bumps them as one group.
- Session handling, delivery rules (`messageAnswer`, `[SILENT]`, steering, recording sends in the bound session) follow soffits/dsh-telegram-bot, so both chat bridges behave alike.

## Identity

- The allowlist is by OpenPGP key fingerprint: Delta Chat contacts are key contacts, and addresses change with relay moves. The fingerprint is computed from the contact's vCard key (v4: SHA-1, v6: SHA-256 over the key packet), checked against what the core shows.
- Strangers get no reply and no read receipt (`marknoticedChat`, not `markseenMsgs`); they are listed in `state.json` for `dsh-deltachat status`.
- The sender line takes the name from the allowlist, not from the contact's display name, which is sanitized and quoted.

## Messages

- Answers are sent once, at `turn/end`, collected from `assistant/message` events. No streaming: every edit in Delta Chat is another encrypted mail.
- Markdown is turned into plain text (`toPlainText`) because Delta Chat apps show plain text.
- Text-only prompts go through `sessionController.prompt` (the Web UI path, with request-id dedupe); prompts with attachments go to `agent.followup`/`agent.steer` with attachment-store blocks, as the controller needs upload receipts for files.
- A message is marked seen only after it is handed to DSH, and fresh messages are processed at start, so nothing is lost across a restart; request ids (`deltachat:<chat>:<msg>`) keep a message from reaching the agent twice.
- An answer quotes its prompt only when the chat moved on since that prompt.
- Session titles are `DeltaChat-<person>-<task>` (the same form as the Telegram bridge's `Telegram-<person>-<task>`). DSH has no title hook, so a generated title is appended again with the prefix and its own source, which keeps automatic titling going; until one exists the title is the chat's name, set as a user title, and `sessionTitle.refresh` runs at the first model request. DSH's built-in fallback title would be the sender line, so the first message's own words replace it. The person and chat name live in `state.json`: session headers take no extra keys.
- Telegram's button menus became numbered lists picked with the same command plus numbers (`/model 2 5`), stateless so a restart in between doesn't break a pick.
- `/fork` makes a new group with the allowed members of the chat: the Delta Chat counterpart of a new Telegram topic.
- Only known command names are commands, so a message starting with a path stays a message.

## Operations

- Everything lives in `$DSH_HOME/deltachat` (survives Host restarts and container redeploys that keep the DSH home).
- Log lines go to stdout/stderr as well as the Cordis logger, because the Host keeps no plugin logger output.
- The command line uses a file spool (the Telegram bot's outbox design): no port, no token, and sends wait while the Host is down.
- `allow` writes `allowedUsers` through the Host's `configEditor`, never by editing the profile file.
- Default relays: nine.testrun.org (default onboarding relay, run by the chatmail developers) and chtml.ca (independent operator, North America), so one operator's outage doesn't cut the bot off.
