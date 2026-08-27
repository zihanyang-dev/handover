/**
 * That every thing the contract carries has a name, and that no two things share one.
 *
 * A client is generated from this document, so a shape without a name is a shape every caller has
 * to spell out by hand — and one that two schemas share is a shape where the later definition
 * silently replaced the earlier, with nothing anywhere saying which one won. Both were found by
 * reading, which is exactly why they are asked here instead.
 *
 * Only two things are asked, and both are mechanical.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONTRACT = 'apps/server/generated/openapi.json'

const SOURCE = 'apps/server/src'

type Shape = {
  type?: string
  properties?: Record<string, Shape>
  items?: Shape
  anyOf?: Shape[]
  oneOf?: Shape[]
  allOf?: Shape[]
}

/**
 * The things inside a schema that have no name of their own.
 *
 * A member of a union is not one of them. The union carries the name, and each arm is a *case* of
 * it rather than a thing — naming them would put `PresenceHere` and `PresenceGone` in a generated
 * client where `Presence` is what anybody reading it means. What must have a name is what a
 * caller ends up holding one of: the element of a list, and an object under a field.
 */
function unnamed(name: string, shape: Shape, at = ''): readonly string[] {
  if (at !== '' && shape.type === 'object' && shape.properties !== undefined)
    return [`${name}${at}`]

  return [
    ...Object.entries(shape.properties ?? {}).flatMap(([key, one]) =>
      unnamed(name, one, `${at}.${key}`),
    ),
    ...(shape.items === undefined ? [] : unnamed(name, shape.items, `${at}[]`)),
    // Walked into, and not counted: an arm of a union is a case, not a thing.
    ...[...(shape.anyOf ?? []), ...(shape.oneOf ?? []), ...(shape.allOf ?? [])].flatMap((one) =>
      Object.entries(one.properties ?? {}).flatMap(([key, under]) =>
        unnamed(name, under, `${at}.${key}`),
      ),
    ),
  ]
}

function everySource(from = SOURCE): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    const path = join(from, entry)

    return statSync(path).isDirectory() ? everySource(path) : path.endsWith('.ts') ? [path] : []
  })
}

/** Capitalised, which is how `list` names the wrapper it builds from the field it wraps. */
function asAName(field: string): string {
  return `${field.slice(0, 1).toUpperCase()}${field.slice(1)}`
}

/**
 * Every name a schema is registered under, however it was written.
 *
 * The third of these is what `list` derives. Left out, the one collision this rule was written
 * after — a wrapper named `Waiting` over an element named `Waiting` — goes unseen.
 */
function namesIn(source: string): readonly string[] {
  return [
    ...[...source.matchAll(/\.openapi\('([A-Za-z]+)'\)/gu)].map((one) => one[1] ?? ''),
    ...[...source.matchAll(/\bnamed\('([A-Za-z]+)'/gu)].map((one) => one[1] ?? ''),
    ...[...source.matchAll(/\blist\('([a-z]+)'/gu)].map((one) => asAName(one[1] ?? '')),
  ]
}

describe('the shapes the contract carries', () => {
  it('all have a name, so no caller has to spell one out by hand', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      components: { schemas: Record<string, Shape> }
    }

    expect(
      Object.entries(contract.components.schemas).flatMap(([name, shape]) => unnamed(name, shape)),
    ).toEqual([])
  })

  it('each have one definition, because the second silently replaces the first', () => {
    const named = new Map<string, string[]>()
    for (const path of everySource()) {
      for (const one of namesIn(readFileSync(path, 'utf8'))) {
        named.set(one, [...(named.get(one) ?? []), path])
      }
    }

    expect([...named].filter(([, where]) => where.length > 1)).toEqual([])
  })
})
