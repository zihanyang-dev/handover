/**
 * Which agents this machine can drive.
 *
 * Adding one is a file next to this and a line below. Nothing else in this program, on the
 * server, or on the page has to be told.
 *
 * The key is the kind, in the same words the server uses. An adapter does not repeat it: two
 * places naming the same agent is two places to disagree about what it is called.
 */

import type { Agent } from './agent.ts'
import { claudeCode } from './claude-code.ts'
import { codex } from './codex.ts'

/**
 * Each adapter is built around this machine's environment, because that is where the PATH
 * captured at connection time lives — and without it both SDKs quietly fall back to a copy of the
 * agent they ship with, which is signed into nothing.
 */
const BUILD: Record<string, (env: NodeJS.ProcessEnv) => Agent> = {
  'claude-code': claudeCode,
  codex,
}

/**
 * Every agent this machine can drive.
 *
 * The registry saying what is in it, so the shared journey suite runs against whatever is
 * registered rather than against a second list of the same names. Registering an adapter is what
 * puts it under those tests.
 */
export const EVERY_KIND: readonly string[] = Object.keys(BUILD)

/**
 * The adapter for a command, or nothing.
 *
 * Discovery finds agents by command, because that is what is on the PATH; the server hands out
 * work by kind. Both arrive here, and the pairing is stated once — in the adapter, which is the
 * one thing that already has to know which binary it drives.
 */
export function agentForCommand(command: string, env: NodeJS.ProcessEnv): Agent | undefined {
  const built = Object.values(BUILD).map((build) => build(env))
  return built.find((agent) => agent.command === command)
}

/**
 * The adapter for a kind, or nothing.
 *
 * A server that knows about an agent this machine has no adapter for is the ordinary way an older
 * machine meets a newer deployment. It has to come back as an absence somebody can report, not as
 * a crash in the middle of a turn.
 */
export function agentFor(kind: string, env: NodeJS.ProcessEnv): Agent | undefined {
  return BUILD[kind]?.(env)
}
