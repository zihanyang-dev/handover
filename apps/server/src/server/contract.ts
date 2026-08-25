/**
 * The words a route declares its contract in.
 *
 * OpenAPI's own shape is four levels deep to say "the body is JSON of this schema". Said once
 * here, a route says what it takes and what each answer is, and never says `application/json` —
 * this API speaks JSON and only JSON, which is worth stating once rather than at every response.
 */

import { OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import { body, MALFORMED, type Failure } from './failure.ts'

/**
 * A path parameter that names a row by its id.
 *
 * The shape, declared, rather than a check somebody writes in a handler. A string that is not a
 * uuid reaches a uuid column and comes back as a database error — a 500 for something the caller
 * did. One route had that guarded by hand and the next one did not, which is what a rule with
 * nothing enforcing it always looks like.
 *
 * The answer is the route's own {@link insteadOfMalformed}, not a generic one: an id that is not
 * an id names no row, which is the same situation as an id that names somebody else's, and
 * telling the two apart would make the URL a way of finding out.
 */
export const rowId = z.uuid()

/**
 * Answers a request this route could not parse in its own words.
 *
 * The app-wide answer is right nearly everywhere — a malformed body is the same thing at every
 * route. It is wrong exactly where the malformed thing is an identifier, because there the caller
 * has somewhere to go, and it is the same somewhere they are sent when the identifier is merely
 * one they may not have.
 */
export function insteadOfMalformed<E extends Env>(failure: Failure) {
  return (result: { success: boolean }, c: Context<E>) =>
    result.success ? undefined : c.json(body(failure), failure.status)
}

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
