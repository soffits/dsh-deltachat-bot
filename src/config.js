/** Editable plugin configuration. Every field is volatile: it is read live. */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_RELAYS } from './constants.js'

export const Config = z.object({
  /** Whether the bot runs while this profile runs. */
  enabled: z.boolean().default(true).volatile(),
  /** Name the bot shows in Delta Chat. */
  displayName: z.string().default('DSH').volatile(),
  /** Absolute path of a picture used as the bot's avatar; empty keeps the current one. */
  avatar: z.string().default('').volatile(),
  /**
   * Chatmail relays the bot keeps an address on, by domain. The first one that
   * works creates the profile; the others are added as extra relays, so the bot
   * stays reachable while one relay is down. Relays added here later are added
   * to the profile; removing one here leaves it in the profile.
   */
  relays: z.array(z.string()).default(DEFAULT_RELAYS).volatile(),
  /**
   * People who may talk to the bot, by OpenPGP key fingerprint (40 hex
   * characters, spaces allowed). `name` is how their messages are labelled for
   * the agent. Everyone else is ignored.
   */
  allowedUsers: z.array(z.object({
    fingerprint: z.string(),
    name: z.string().default(''),
  })).default([]).volatile(),
  /**
   * JSON file whose `deltachat_keys` object maps key fingerprints to the names
   * used in session titles (`DeltaChat-<name>-<task>`); empty uses the
   * `allowedUsers` name, then the contact's own name.
   */
  peopleFile: z.string().default('').volatile(),
  /** Working directory of sessions the bot creates. */
  cwd: z.string().default(process.cwd()).volatile(),
  /** Agent preset of sessions the bot creates; empty uses the Host default. */
  agentPreset: z.string().default('').volatile(),
  /**
   * Also show turns started elsewhere (Web UI, scheduled tasks, other plugins)
   * in the chat bound to their session.
   */
  mirrorTurns: z.boolean().default(true).volatile(),
  /**
   * Messages sent while the session's turn runs: `steer` sends them into that
   * turn (as the Web UI does); `queue` holds them until the turn ends.
   */
  busyMessages: z.union(['steer', 'queue']).default('steer').volatile(),
  /**
   * How voice messages and audio files become text: `dsh` uses the DSH
   * speech-to-text service (decoded with ffmpeg), `command` runs
   * `transcribeCommand`, `off` passes only the file.
   */
  transcriber: z.union(['dsh', 'command', 'off']).default('dsh').volatile(),
  /** Language hint for the DSH speech-to-text service; empty uses its setting. */
  transcribeLanguage: z.string().default('').volatile(),
  /**
   * Program and arguments for `transcriber: command`, run without a shell.
   * `{file}` is replaced by the recording's path (appended when absent).
   */
  transcribeCommand: z.array(z.string()).default([]).volatile(),
  /** ffmpeg program used to decode recordings for the DSH service. */
  ffmpegPath: z.string().default('ffmpeg').volatile(),
})
