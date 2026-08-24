/**
 * The words a route declares its contract in.
 *
 * OpenAPI's own shape is four levels deep to say "the body is JSON of this schema". Said once
 * here, a route says what it takes and what each answer is, and never says `application/json` —
 * this API speaks JSON and only JSON, which is worth stating once rather than at every response.
 */

import { OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Env } from 'hono'
import { body, MALFORMED } from './failure.ts'

export function takes<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, required: true }
}

export function sends<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } }
}

/** An answer with nothing in it: a 204, or a redirect the browser is expected to follow. */
export function saysNothing(description: string) {
  return { description }
}

/**
 * An app that answers a request it could not parse the same way everywhere.
 *
 * A body that is not the shape it claims is not a product outcome — it is the same answer at
 * every route and never varies — so it is stated once here rather than at each one.
 */
export function api<E extends Env>(): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(body(MALFORMED), MALFORMED.status)
      return undefined
    },
  })
}
