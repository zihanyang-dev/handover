import { afterAll, describe, expect, it } from 'vitest'
import { loadEnv } from './env.ts'
import { s3Objects } from './object-store.ts'

const objects = s3Objects(loadEnv())

afterAll(() => {
  objects.close()
})

describe('the S3-compatible object boundary', () => {
  it('writes bytes that a later read gets back with their media type', async () => {
    // One fixed key keeps repeated test runs from turning the local bucket into a growing log.
    const key = 'checks/object-store.txt'
    const written = {
      bytes: new TextEncoder().encode('the bucket answered'),
      contentType: 'text/plain',
    }

    await objects.put(key, written)
    const found = await objects.find(key)

    expect(found?.contentType).toBe(written.contentType)
    expect(new TextDecoder().decode(found?.bytes)).toBe('the bucket answered')
  })

  it('distinguishes a missing key from an unreachable store', async () => {
    expect(await objects.find('checks/never-written')).toBeUndefined()
  })
})
