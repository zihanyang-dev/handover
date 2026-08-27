/**
 * That every route is behind the door its address promises.
 *
 * A rule, not a test of `app.ts`: it reads the published contract rather than the app, because
 * the contract is what a client is generated from and what anybody reads. `pnpm check` rebuilds
 * it and fails on any diff before this runs, so it cannot be stale here.
 *
 * Mechanical because the failure is silent. A route mounted behind the wrong door works
 * perfectly — for the wrong caller — and nothing about it looks wrong in review.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHOWS } from '../apps/server/src/server/route.ts'

const CONTRACT_FILE = 'apps/server/generated/openapi.json'

describe('what the contract says about who may call what', () => {
  /**
   * Every operation in the published contract, with the credential it says a caller has to show.
   *
   * Read off the file rather than out of the app, because the file is what a client is generated
   * from and what anybody reads. `pnpm check` rebuilds it before this runs and fails on any diff,
   * so it cannot be stale here.
   */
  function everyEndpoint(): readonly {
    at: string
    shows: readonly string[]
    answers: readonly number[]
  }[] {
    const document = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')) as {
      paths: Record<
        string,
        Record<
          string,
          {
            security?: readonly Record<string, unknown>[]
            responses: Record<string, unknown>
          }
        >
      >
    }

    const endpoints = []
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const shows = (operation.security ?? []).flatMap((one) => Object.keys(one))
        const answers = Object.keys(operation.responses).map(Number)
        endpoints.push({ at: `${method.toUpperCase()} ${path}`, shows, answers })
      }
    }

    return endpoints
  }

  it('names a machine credential on every path only a machine can use', async () => {
    // The path says who it is for — `/machines/current/…` is a machine talking about itself — and
    // the door has to agree. One mounted behind the wrong door would be a browser able to write
    // an agent's half of a transcript, which no amount of care at the handler can undo.
    const machines = everyEndpoint().filter((one) => one.at.includes(' /machines/current/'))

    expect(machines.length).toBeGreaterThan(0)
    for (const one of machines) expect([one.at, one.shows]).toEqual([one.at, [SHOWS.machine]])
  })

  it('names a session on every path that belongs to a person', async () => {
    const people = everyEndpoint().filter(
      (one) => one.at.includes(' /spaces') || one.at.includes(' /me'),
    )

    expect(people.length).toBeGreaterThan(0)
    for (const one of people) expect([one.at, one.shows]).toEqual([one.at, [SHOWS.session]])
  })

  it('says a Space you are not in is one that is not there, on every path inside one', async () => {
    // The membership door answers both with the same 404, so that a URL cannot be used to find
    // out which Spaces exist. A route that declared only a 401 would be telling a client the
    // difference is knowable, and the first client to act on that turns the address bar into a
    // way of asking.
    const inASpace = everyEndpoint().filter((one) => one.at.includes('/spaces/{slug}'))

    expect(inASpace.length).toBeGreaterThan(0)
    for (const one of inASpace) expect([one.at, one.answers.includes(404)]).toEqual([one.at, true])
  })

  it('leaves open only the ways in and the pictures, and nothing else', async () => {
    // Everything else has to be behind something. This is the list somebody has to change on
    // purpose — and the reason to make it hard is that adding a route is easy.
    //
    // Two reasons to be open, kept apart because they are not the same reason. A way in is open
    // because nobody can hold a credential yet. A face is open because it is a picture a browser
    // asks for with `<img>`, which carries no session — and asking for one would put identity in
    // every private cache and every image proxy between here and the screen, for bytes that are
    // synthetic and say nobody's name.
    const WAYS_IN = [
      'GET /auth/credentials',
      'GET /auth/{provider}/callback',
      'POST /auth/email-codes',
      'POST /auth/{provider}/start',
      'POST /browser/sessions',
      'POST /enrolments',
      'POST /enrolments/collect',
    ]
    const PICTURES = [
      'GET /avatars/agents/{machineId}/{agentKind}',
      'GET /avatars/users/{userId}',
    ]

    const open = everyEndpoint()
      .filter((one) => one.shows.length === 0)
      .map((one) => one.at)
      .sort()

    expect(open).toEqual([...WAYS_IN, ...PICTURES].sort())
  })
})
