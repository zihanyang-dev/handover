/**
 * How to run this program again.
 *
 * It matters because an agent is told to run it. "Run `handover`" is an assumption about a PATH
 * nobody checked; this is the command that already worked, on the machine it worked on.
 */

import { describe, expect, it } from 'vitest'
import { FROM_SOURCE, howToRunThis, howToStartThis, whereToConnect } from './env.ts'

describe('how to run this program again', () => {
  it('is the runtime and the script, when this is a checkout', () => {
    expect(howToRunThis(['/usr/bin/node', '/app/src/main.ts'], '/usr/bin/node')).toBe(
      '/usr/bin/node /app/src/main.ts',
    )
  })

  /**
   * The one that was wrong in the first release.
   *
   * A compiled build reports `["bun", "/$bunfs/root/handover-darwin-arm64"]` — a word that is not
   * a path, and a path inside a virtual root that is not on disk. Taken at face value, the
   * service file was written with `/$bunfs/…` as its first argument and the service exited
   * saying "no such command", and the line handed to an agent was one no agent could run.
   */
  it('is the binary alone, when this is the one file somebody downloaded', () => {
    const argv = ['bun', '/$bunfs/root/handover-darwin-arm64']

    expect(howToRunThis(argv, '/usr/local/bin/handover')).toBe('/usr/local/bin/handover')
    expect(howToStartThis(argv, '/usr/local/bin/handover')).toEqual({
      executable: '/usr/local/bin/handover',
      before: [],
    })
  })

  it('quotes a path with a space in it, because somewhere on somebody machine there is one', () => {
    expect(howToRunThis(['bun', '/$bunfs/root/x'], '/Applications/My Tools/handover')).toBe(
      "'/Applications/My Tools/handover'",
    )
  })

  it('falls back to the binary, rather than to something that cannot be run', () => {
    expect(howToRunThis([], '/usr/local/bin/handover')).toBe('/usr/local/bin/handover')
  })
})

describe('which deployment a machine is about to join', () => {
  it('is whatever was said, whoever is asking', () => {
    expect(whereToConnect('https://handover.example.com', FROM_SOURCE)).toBe(
      'https://handover.example.com',
    )
    expect(whereToConnect('https://handover.example.com', 'v1.2.3')).toBe(
      'https://handover.example.com',
    )
  })

  it('is this machine when nothing said, and this is a checkout', () => {
    expect(whereToConnect(undefined, FROM_SOURCE)).toBe('http://localhost:3000')
  })

  // The one that matters. A downloaded binary that assumed localhost would connect somebody's
  // laptop to itself and report success — wrong in the one way that reads exactly like right.
  it('is nothing at all when nothing said and this was downloaded', () => {
    expect(whereToConnect(undefined, 'v1.2.3')).toBeUndefined()
  })
})
