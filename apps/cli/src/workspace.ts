/**
 * Where one turn works.
 *
 * A conversation gets a folder of its own and the agent is started in it. Not a container, not a
 * worktree, not a checkout — an empty directory. Whatever the work needs goes in it because the
 * agent put it there: it can clone, download and write, and it has the whole turn to do it.
 *
 * That is the whole of what makes several at once safe. The limit this replaces was a machine
 * running exactly one thing, and the reason written into that migration was not parallelism — it
 * was that two agents in one directory overwrite each other's files. Two directories, no reason.
 *
 * The server says which of three cases this turn is; turning that into a path happens here and
 * nowhere else. A sandbox answers the same three cases with a root of its own, which is why no
 * path this file computes is ever sent back.
 */

import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { components } from '../generated/api.ts'

/** Which of the three places a turn works in, as the server says it. */
type WhereToWork = components['schemas']['WhereToWork']

/** One turn, in the only things about it that decide where it happens and what that means. */
type Working = {
  readonly conversationId: string
  readonly where: WhereToWork
  /**
   * Whether anything has been run in this conversation before.
   *
   * The server's answer, because only it can give one: this process may not be the one that ran
   * the last turn, or even on the machine that did.
   */
  readonly hasRunBefore: boolean
}

export type Workspace =
  | {
      readonly kind: 'ready'
      readonly path: string
      /**
       * Whether what was in here is gone.
       *
       * Having to make the folder is ordinary on a first turn and means something else on a
       * later one: it was there, somebody deleted it, and the turn about to run will find
       * nothing where the last one left everything. Decided here rather than by the caller,
       * because both halves of it are about this folder and neither is about the loop.
       *
       * Nothing is broken by it — the folder is back, and the agent's memory of the last turn is
       * a session id kept elsewhere. What would be wrong is saying nothing, and leaving the agent
       * looking as though it had lost the work.
       */
      readonly startedOver: boolean
    }
  /** A person named a directory that is not there. Nothing was made in its place. */
  | { readonly kind: 'no-such-directory'; readonly path: string }
  /**
   * A person named a path that does not say where it starts from.
   *
   * Refused rather than resolved. A relative path is read against whatever directory this process
   * happens to be in — which is where `connect` was typed when a person runs it and `/` when a
   * service manager does, so the same conversation would work in two different places depending
   * on how the machine was started, and one of them silently.
   */
  | { readonly kind: 'not-an-absolute-path'; readonly path: string }

/**
 * Where every conversation's folder goes on this machine.
 *
 * Under a home directory rather than beside the credential: what `store.ts` keeps is a few lines
 * of configuration, and this is a clone of somebody's repository plus whatever else the work
 * needed. A service running for everyone has a home of its own, and so keeps its own.
 */
export function workRootIn(home: string): string {
  return join(home, '.handover', 'work')
}

/**
 * The folder this turn works in, whether or not it exists yet.
 *
 * A sub-task goes **under the folder of the work it belongs to**, never inside the directory that
 * work was pointed at. Two things follow, and both are the point: it reads what its parent has
 * been writing by being one level down, and `subtask/` never appears inside somebody's own
 * checkout — where it would show up as untracked in every `git status` they ran.
 *
 * Exported for its own tests, which is the whole reason it is separate from the function below:
 * these three rules are the ones worth pinning and none of them needs a disk. Read through
 * `prepareWorkspace`, every one of them would be tested by making directories.
 */
export function whereToWork(where: WhereToWork, conversationId: string, workRoot: string): string {
  switch (where.kind) {
    case 'its-own':
      return join(workRoot, conversationId)
    case 'somewhere-named':
      return where.path
    case 'under':
      return join(workRoot, where.conversationId, 'subtask', conversationId)
  }
}

/**
 * The folder, made if it is ours to make.
 *
 * Ours means one we named. A directory a person typed is not made here: a path with a typo in it
 * would be created empty and the agent would work in it and find nothing, which reads as the
 * agent losing the files rather than as the one thing that actually happened.
 */
export async function prepareWorkspace(working: Working, workRoot: string): Promise<Workspace> {
  const path = whereToWork(working.where, working.conversationId, workRoot)

  if (working.where.kind !== 'somewhere-named') {
    // `mkdir` hands back the first directory it created, and nothing at all when there was
    // nothing to create — which is the only way to tell "made this now" from "already there".
    // Recursive, so every level of a sub-task's path arrives at once.
    const made = await mkdir(path, { recursive: true })

    return { kind: 'ready', path, startedOver: made !== undefined && working.hasRunBefore }
  }

  if (!isAbsolute(path)) return { kind: 'not-an-absolute-path', path }

  // Nothing when there is nothing there, which is the question being asked. Any other reason
  // `stat` fails — a permission, a broken link — reads the same way here on purpose: the next
  // lines decide what to do about a path this process cannot use, and why it cannot is the
  // same answer to them.
  const there = await stat(path).catch(() => undefined)
  if (there?.isDirectory() !== true) return { kind: 'no-such-directory', path }

  // Never started over: this one is a person's, and nothing here made it or could have.
  return { kind: 'ready', path, startedOver: false }
}
