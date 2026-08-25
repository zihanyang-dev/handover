import { describe, expect, it } from 'vitest'
import { offering } from './offering.ts'

/** No agent is on this PATH, so asking is quick and answers nothing — which is not the point. */
const NOWHERE = { PATH: '/nonexistent' }

const found = (version: string) => [{ command: 'claude', version }]

describe('asking an agent what it offers', () => {
  it('asks the first time it sees a version', async () => {
    const asks = offering(NOWHERE, '/nowhere')

    expect((await asks(found('2.1.4')))[0]).toHaveProperty('models')
  })

  it('says nothing about it on every report after that', async () => {
    // The whole reason the list is stored on the server: asking costs starting the agent up, so
    // the ordinary report does not mention models at all and what was stored stands.
    const asks = offering(NOWHERE, '/nowhere')
    await asks(found('2.1.4'))

    expect((await asks(found('2.1.4')))[0]).not.toHaveProperty('models')
  })

  it('asks again when that agent has been upgraded', async () => {
    // A model list is a thing a version can do, so a new version is the one moment it can have
    // changed — and the only moment worth paying a process for.
    const asks = offering(NOWHERE, '/nowhere')
    await asks(found('2.1.4'))

    expect((await asks(found('2.2.0')))[0]).toHaveProperty('models')
  })

  it('does not keep asking about a command this machine cannot drive', async () => {
    const asks = offering(NOWHERE, '/nowhere')
    const unknown = [{ command: 'some-agent-from-next-year', version: '1.0.0' }]

    expect((await asks(unknown))[0]).toEqual({ ...unknown[0], models: [] })
    expect((await asks(unknown))[0]).not.toHaveProperty('models')
  })
})

describe('an agent that cannot answer', () => {
  it('does not take the whole report down with it', async () => {
    // A model list is optional; being reported at all is not. An agent installed but not signed
    // in would otherwise hold a perfectly usable machine out of its Space.
    const asks = offering(NOWHERE, '/nowhere')

    const reported = await asks([...found('2.1.4'), { command: 'codex', version: '0.9.0' }])

    expect(reported.map((one) => one.command)).toEqual(['claude', 'codex'])
    expect(reported.every((one) => 'models' in one)).toBe(true)
  })
})
