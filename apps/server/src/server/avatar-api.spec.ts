import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ObjectStore, StoredObject } from '../object-store.ts'
import { avatarApi } from './avatar-api.ts'
import { mounted } from './route.ts'

/** The bucket boundary, without making a test about an SDK call sequence. */
function emptyBucket() {
  const kept = new Map<string, StoredObject>()
  let writes = 0
  const objects: ObjectStore = {
    find: async (key) => kept.get(key),
    put: async (key, object) => {
      writes += 1
      kept.set(key, object)
    },
    close: () => undefined,
  }

  return { objects, kept, writes: () => writes }
}

describe('a stored avatar', () => {
  it('is generated into the bucket once, then served from those bytes', async () => {
    const bucket = emptyBucket()
    const app = mounted(avatarApi({ objects: bucket.objects }))
    const path = `/avatars/users/${randomUUID()}`

    const first = await app.request(path)
    const firstSvg = await first.text()
    const second = await app.request(path)

    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('image/svg+xml')
    expect(firstSvg).toContain('<svg')
    expect(await second.text()).toBe(firstSvg)
    expect(bucket.writes()).toBe(1)
    expect(bucket.kept.size).toBe(1)
  })

  it('uses the immutable key as its validator', async () => {
    const bucket = emptyBucket()
    const app = mounted(avatarApi({ objects: bucket.objects }))
    const path = `/avatars/users/${randomUUID()}`
    const first = await app.request(path)

    const response = await app.request(path, {
      headers: { 'if-none-match': first.headers.get('etag') ?? '' },
    })

    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(bucket.writes()).toBe(1)
  })

  it('renders an agent as crisp Pixel Art', async () => {
    const bucket = emptyBucket()
    const app = mounted(avatarApi({ objects: bucket.objects }))
    const response = await app.request(`/avatars/agents/${randomUUID()}/codex`)
    const svg = await response.text()

    expect(svg).toContain('<dc:title>Pixel Art</dc:title>')
    expect(svg).toContain('shape-rendering="crispEdges"')
  })

  it('gives two installations of the same agent two identities', async () => {
    const bucket = emptyBucket()
    const app = mounted(avatarApi({ objects: bucket.objects }))
    const first = await app.request(`/avatars/agents/${randomUUID()}/codex`)
    const second = await app.request(`/avatars/agents/${randomUUID()}/codex`)

    expect(await first.text()).not.toBe(await second.text())
    expect(bucket.kept.size).toBe(2)
  })
})
