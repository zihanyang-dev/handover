/**
 * Whether a newer build of this program has been released.
 *
 * Asked of the place the installer downloads from, not of the Space this machine belongs to. A
 * server would have to be told which build is current — by us, by hand, on every release — and it
 * would be one more thing that can be wrong about a fact GitHub already holds. `gh` asks GitHub,
 * Tailscale asks its own download host; neither asks its control plane.
 *
 * The redirect rather than the API: `/releases/latest` answers with a `location` naming the tag,
 * which needs no token, is not subject to the sixty-an-hour limit an anonymous API call is, and
 * has nothing in it to parse wrongly.
 *
 * Never throws, and says nothing at all unless it is certain. Somebody who cannot reach GitHub is
 * usually behind a firewall on purpose, and telling them so on every connect is noise about a
 * question nobody asked.
 */

/** Long enough for a slow network, short enough that nobody waits on it to connect a machine. */
const ANSWER_WITHIN_MS = 3000

/** Where releases live. `install.sh` carries this name too — it has no way to read this one. */
const RELEASES = 'https://github.com/zihanyang-dev/handover/releases/latest'

/** A released build is `v1.2.3`. Anything else — a working copy, a tag by hand — is not comparable. */
const RELEASED = /^v(\d+)\.(\d+)\.(\d+)$/u

function numbered(version: string): readonly number[] | undefined {
  const read = RELEASED.exec(version)
  return read === null ? undefined : read.slice(1).map(Number)
}

/** Whether the second is a later release than the first. The first difference decides. */
export function isNewer(than: string, other: string): boolean {
  const ours = numbered(than)
  const theirs = numbered(other)
  if (ours === undefined || theirs === undefined) return false

  for (const [at, part] of theirs.entries()) {
    const mine = ours[at] ?? 0
    if (part !== mine) return part > mine
  }

  return false
}

/**
 * The tag of the newest release, if the answer is legible.
 *
 * A repository with no releases redirects to the list rather than to a tag, which is not an error
 * and not a version — it is the honest state of a project that has not published one yet.
 */
async function latestRelease(asking: typeof fetch): Promise<string | undefined> {
  const answered = await asking(RELEASES, {
    redirect: 'manual',
    signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
  }).catch(() => undefined)

  const where = answered?.headers.get('location') ?? ''
  const [, tag] = /\/releases\/tag\/([^/?#]+)$/u.exec(where) ?? []

  return tag
}

/**
 * The version worth telling somebody about, or nothing.
 *
 * Nothing when this build is a working copy: there is no released version to be behind, and a
 * notice would be about a comparison nobody can make.
 */
export async function newerRelease(
  version: string,
  asking: typeof fetch = fetch,
): Promise<string | undefined> {
  if (numbered(version) === undefined) return undefined

  const latest = await latestRelease(asking)
  return latest !== undefined && isNewer(version, latest) ? latest : undefined
}
