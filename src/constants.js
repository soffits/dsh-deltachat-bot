/** Shared constants and on-disk locations. */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Loader row id and settings namespace; the npm package is @soffits/dsh-deltachat-bot. */
export const name = 'deltachat-bot'

/** Name of the Host service other plugins send through. */
export const SERVICE_NAME = 'deltachatChats'

/**
 * Directory holding everything the bot keeps: the Delta Chat profile, the
 * chat → session map, the send log, the spool and diagnostics. Read at call
 * time, so tests and throwaway homes can move it with DSH_HOME.
 * @returns absolute path.
 */
export function dataDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'deltachat')
}

/** @returns the Delta Chat accounts directory (owned by the core's RPC server). */
export function accountsDir() {
  return join(dataDir(), 'accounts')
}

/** @returns the request spool used by the `dsh-deltachat` command. */
export function spoolDir() {
  return join(dataDir(), 'spool')
}

/** Relays used when a new profile is created and no relays are configured. */
export const DEFAULT_RELAYS = ['nine.testrun.org', 'chtml.ca']

/** A final answer ending in exactly this text posts nothing more in the chat. */
export const SILENT_REPLY = '[SILENT]'

/** Longest text sent as one Delta Chat message; longer answers are split. */
export const MAX_MESSAGE_TEXT = 30_000

/** Reaction that tells the sender a message reached the running turn. */
export const STEER_REACTION = '👀'

/** Prefix of the request ids of prompts that came from Delta Chat. */
export const REQUEST_PREFIX = 'deltachat:'

/** Source kind of the copy a send leaves in the bound session. */
export const POST_SOURCE_KIND = 'deltachat-post'

/** Largest file sent or attached, in bytes. Chatmail relays reject bigger mails. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024
