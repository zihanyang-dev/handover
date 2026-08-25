/**
 * The words a route declares its contract in.
 *
 * OpenAPI's own shape is four levels deep to say "the body is JSON of this schema". Said once
 * here, a route says what it takes and what each answer is, and never says `application/json` —
 * this API speaks JSON and only JSON, which is worth stating once rather than at every response.
 */

import { defineOpenAPIRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { OpenAPIRoute, RouteConfig, RouteHandler } from '@hono/zod-openapi'
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

/**
 * An answer that keeps going: one JSON value per `data:` line, for as long as there is anything
 * to say. The schema is what one line holds, not what the whole answer is — there is no whole.
 */
export function streams<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'text/event-stream': { schema } } }
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

/**
 * Endpoints behind one door.
 *
 * A door is named once per file, and every endpoint behind it says only its two halves: the
 * contract it answers by, and what it does. Named rather than told apart by which came first —
 * `}, async (c) => {` reads as one thing, and they are two.
 *
 * `addRoute` is said out loud because it has to be: left off, its type is `boolean | undefined`,
 * and this repository's `exactOptionalPropertyTypes` will not have that where a `boolean` is
 * wanted. Saying `true` is also the truth — every endpoint here is one the router serves.
 */
export function endpointsBehind<E extends Env>() {
  return <R extends RouteConfig>(it: {
    route: R
    handler: RouteHandler<R, E>
    /**
     * What to answer instead when this route's own request will not parse.
     *
     * Taken from the shape this is passed to rather than from the exported `RouteHook`: the two
     * disagree about whether a hook may return nothing, and the one that matters is the one the
     * value is going into.
     */
    hook?: OpenAPIRoute<R, E, true>['hook']
  }) => defineOpenAPIRoute<R, E, true>({ ...it, addRoute: true })
}
