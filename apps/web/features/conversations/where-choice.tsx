/**
 * Where the agent works, chosen once — when the conversation is opened and never after.
 *
 * `03` promised an agent works in your files, in the directory `handover connect` was run in.
 * `07` gives every conversation a folder of its own so that several can run at once without
 * treading on each other, which would have quietly ended that promise: an empty folder cannot
 * answer "read src/payment", and a clone cannot reproduce what you have not committed. So the
 * promise becomes a choice, and this is where it is made.
 *
 * Only here, because a conversation is pinned to one directory for its whole life — `04` ⑤ says
 * handing it over changes who is watching and nothing else. A control on the chat screen would be
 * offering to move work that has already been done.
 *
 * Nothing is shown when the machine has not said which directory it was connected in, which is a
 * build older than the field. Its own folder is what happens then, and it is also the default.
 */

import { ChoiceMenu, type Choice } from './choice-menu.tsx'

/** How much of a path is worth reading on a control this size: the last two parts of it. */
function shortPath(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')

  return parts.slice(-2).join('/') || path
}

export function WhereChoice({
  connectedIn,
  worksIn,
  onWorksIn,
}: {
  /** The directory that machine was connected in, when it is a build that says so. */
  readonly connectedIn: string | undefined
  /** Empty means a folder of its own, which is what the server understands by nothing at all. */
  readonly worksIn: string
  readonly onWorksIn: (worksIn: string) => void
}) {
  if (connectedIn === undefined) return null

  const itsOwn: Choice = {
    value: '',
    label: 'Its own folder',
    about: 'Starts empty. It clones or downloads whatever it needs.',
  }

  return (
    <ChoiceMenu
      label="Where it works"
      section="On this machine"
      saysNothing={itsOwn}
      alternatives={[{ value: connectedIn, label: shortPath(connectedIn), about: connectedIn }]}
      value={worksIn}
      onChange={onWorksIn}
    />
  )
}
