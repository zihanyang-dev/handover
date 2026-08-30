/**
 * How to run this program again.
 *
 * It matters because an agent is told to run it. "Run `handover`" is an assumption about a PATH
 * nobody checked; this is the command that already worked, on the machine it worked on.
 */

import { describe, expect, it } from 'vitest'
import { FROM_SOURCE, howToRunThis, whereToConnect } from './env.ts'

describe('how to run this program again', () => {
  it('is the runtime and the file, when this is running from source', () => {
    expect(howToRunThis(['/usr/bin/node', '/opt/handover/main.js'])).toBe(
      '/usr/bin/node /opt/handover/main.js',
    )
  })

  it('is the binary on its own, when there is no script to hand to a runtime', () => {
    // A single-file build reports itself as both, and telling an agent to run it twice would be
    // telling it something that does not work.
    expect(howToRunThis(['/usr/local/bin/handover', '/usr/local/bin/handover'])).toBe(
      '/usr/local/bin/handover',
    )
  })

  it('quotes a path with a space in it, because somewhere on somebody machine there is one', () => {
    expect(howToRunThis(['/Applications/My Tools/handover'])).toBe(
      "'/Applications/My Tools/handover'",
    )
  })

  it('falls back to the name, rather than to something that cannot be run', () => {
    expect(howToRunThis([])).toBe('handover')
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
