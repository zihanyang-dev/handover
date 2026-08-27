/**
 * The words a route declares itself in: what it takes, what it answers, and how it is built.
 *
 * OpenAPI's own shape is four levels deep to say "the body is JSON of this schema". Responses once
 * here, a route says what it takes and what each answer is, and never says `application/json` —
 * this API speaks JSON and only JSON, which is worth stating once rather than at every response.
 *
 * A door is one of those words. {@link doorway} takes a gate — from `middleware.ts`, which is
 * all a gate is — and gives back the five methods behind it, already carrying the credential the
 * contract shows, the refusals that come with the door, and the path pieces it always has.
 */

import {
  OpenAPIHono,
  type OpenAPIRoute,
  type RouteConfig,
  type RouteHandler,
  createRoute,
  defineOpenAPIRoute,
  z,
} from '@hono/zod-openapi'
import type { Context, Env, MiddlewareHandler, TypedResponse } from 'hono'
import type { Database } from '../db/connection.ts'
import { failureBody, MALFORMED, refused, type Failure, type Status } from './failure.ts'
import {
  requireMachine,
  requireMember,
  requireOwner,
  requireOwnerOrYourself,
  requireSession,
  type Attached,
  type InSpace,
  type Signed,
} from './middleware.ts'

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

function takes<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, required: true }
}

/**
 * Answers a request this route could not parse in its own words.
 *
 * The app-wide answer is right nearly everywhere — a malformed body is the same thing at every
 * route. It is wrong exactly where the malformed thing is an identifier, because there the caller
 * has somewhere to go, and it is the same somewhere they are sent when the identifier is merely
 * one they may not have.
 */
function insteadOfMalformed<E extends Env>(failure: Failure) {
  return (result: { success: boolean }, c: Context<E>) =>
    result.success ? undefined : refused(c, failure)
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
function saysNothing(description: string) {
  return { description }
}

/** A named schema, so the generated client calls it what this codebase calls it. */
export function named<T extends z.ZodRawShape>(name: string, shape: T) {
  return z.object(shape).openapi(name)
}

/**
 * Many of them, under the one word a screen would use for the list.
 *
 * Named after that word, because a browser's test double answers this endpoint by naming the
 * shape — `HttpResponse.json<Machines>({ machines })` — and an anonymous wrapper leaves it with
 * nothing to name. Found by taking one away.
 *
 * The cast is what keeps the key a key. Written without it, a computed property name types the
 * object as `{ [x: string]: … }`, and an index signature accepts every name — so a handler that
 * answered `{ wrongKey: … }` type-checked, and the one thing this contract exists to check went
 * unchecked. Found by trying it.
 */
export function list<K extends string, T extends z.ZodType>(of: K, each: T) {
  return z
    .object({ [of]: z.array(each).readonly() } as { [P in K]: z.ZodReadonly<z.ZodArray<T>> })
    .openapi(`${of[0]?.toUpperCase() ?? ''}${of.slice(1)}`)
}

/** An answer with a body: what {@link refusal} and {@link sends} build. */
type Body = RouteConfig['responses'][string]

/** Marks which status a refusal is, so the status it is declared under has to be that one. */
declare const isFor: unique symbol

/** A refusal, in the words this route's callers need to read. */
type Refuses<S extends Status> = Body & { readonly [isFor]?: S }

/** Any other answer with a body. Not a refusal, so it cannot be named under the wrong status. */
type Sends = Body & { readonly [isFor]?: never }

/** A refusal, as a response: always the same two fields, and this route's words for them. */
export function refusal(description: string) {
  return sends(failureBody, description)
}

/**
 * A refusal a route names, said in its own words.
 *
 * The failure and the sentence together, because the status comes from the failure: naming this
 * under 409 when the failure is a 404 does not compile, and the published contract cannot say a
 * status the handler never answers with. The mark is a type and nothing else — it is not a
 * property, and nothing of it reaches the document.
 */
export function refuses<S extends Status>(failure: Failure<S>, description: string) {
  return refusal(description) as Refuses<S>
}

/**
 * Answers with nothing in it, at a status that means it.
 *
 * `c.body(null, 204)` says the body is `null`; the contract says there is no body at all, and
 * OpenAPI has no way to write down the difference. The cast is where those two meet, and it is
 * here once rather than at each of the routes that answer this way.
 */
export function nothing<S extends 204, E extends Env>(c: Context<E>, status: S) {
  return c.body(null, status) as unknown as TypedResponse<Record<never, never>, S, string> &
    Response
}

/**
 * Sends the browser somewhere else, and says nothing.
 *
 * The same seam as {@link nothing}: a redirect has no body, and OpenAPI cannot write down the
 * difference between that and a body of `undefined`. Here once rather than at each route.
 */
export function redirected<E extends Env>(c: Context<E>, to: string) {
  return c.redirect(to, 303) as unknown as TypedResponse<Record<never, never>, 303, string> &
    Response
}

/**
 * The answers that come with a door rather than with a route.
 *
 * Not `as const`: a readonly response is one a route can declare and a handler cannot then return,
 * so the door would be documented and unusable. The shapes here are already literal.
 *
 * Every route behind the same door refuses the same way, and saying so at each of them is the
 * same sentence written nineteen times — nineteen places for it to drift, and no way to tell a
 * route that means something different from one that was copied.
 *
 * A route spreads the door it is behind and then says only what is its own.
 */
const BEHIND_A_SESSION = { 401: refusal('Nobody is signed in here') }

const BEHIND_A_MACHINE = { 401: refusal('That is not a live machine credential') }

/** What any route that takes a body answers when the body is not the shape it claims. */
const MALFORMED_BODY = { 400: refusal('The body was not the shape it claims') }

/**
 * What a route answers, by status.
 *
 * A string is an answer with no body. Anything else carries one, and a refusal carries the
 * status it is for.
 */
type Answers = { readonly [S in Status]?: string | Refuses<S> | Sends } & {
  readonly [S in 200 | 201 | 204 | 302 | 303]?: string | Sends
}

/** What `answers` turns into: the OpenAPI responses a route would otherwise write by hand. */
type Responses<A extends Answers> = {
  [S in keyof A]: A[S] extends Body ? A[S] : { description: string }
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** The answers a door has already decided, ready to be merged under a route's own. */
type Decided = Record<number, Body>

/**
 * The route that comes out, as a type — so the handler is typed by what this very call declared.
 *
 * Written out rather than inferred, because inference would have to run through `createRoute`
 * before the argument holding the handler is checked, and it cannot.
 */
type Built<
  P extends z.ZodRawShape,
  Q extends z.ZodRawShape,
  B extends z.ZodType | undefined,
  A extends Answers,
  Own extends Decided,
> = {
  method: Method
  path: string
  request: { params: z.ZodObject<P>; query: z.ZodObject<Q> } & (B extends z.ZodType
    ? { body: { content: { 'application/json': { schema: B } }; required: true } }
    : Record<never, never>)
  responses: { [S in keyof (Own & Responses<A>)]: (Own & Responses<A>)[S] }
}

/** One route's own declaration: everything about it the door does not already know. */
type Declared<
  E extends Env,
  P extends z.ZodRawShape,
  Whole extends z.ZodRawShape,
  Q extends z.ZodRawShape,
  B extends z.ZodType | undefined,
  A extends Answers,
  Own extends Decided,
> = {
  readonly summary: string
  readonly params?: P
  readonly query?: Q
  readonly body?: B
  readonly answers: A
  /** What a body or an id this route could not parse is answered with, when not the app's own. */
  readonly instead?: Failure
  readonly run: RouteHandler<Built<Whole, Q, B, A, Own>, E>
}

/**
 * What a door asks a caller to show.
 *
 * Two credentials for six doors, and that is not a mistake: a membership door asks for the same
 * cookie a session door does, and then answers a Space somebody is not in as one that is not
 * there. That is a fact about what it answers, not about what it asks for. `app.ts` is where the
 * contract learns what these two names mean.
 */
export const SHOWS = {
  session: 'browserSession',
  machine: 'machineToken',
} as const

type Shows = (typeof SHOWS)[keyof typeof SHOWS]

/**
 * Publishes one route, with the credential its door asks for already on it.
 *
 * Responses here rather than at each endpoint, which is the only way it stays true: a route that had
 * to remember to declare its own credential is a route that will forget, and a contract that
 * forgot presents a guarded endpoint as one anybody may call.
 */
function endpointsBehind<E extends Env>(shows?: Shows) {
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
  }) =>
    defineOpenAPIRoute<R, E, true>({
      ...it,
      // Responses once per door rather than once per endpoint, which is the only way it stays true:
      // a route that had to remember to declare its own credential is a route that will forget.
      ...(shows === undefined ? {} : { route: { ...it.route, security: [{ [shows]: [] }] } }),
      // Responses out loud because it has to be: left off, its type is `boolean | undefined`, and
      // this repository's `exactOptionalPropertyTypes` will not have that where a `boolean` is
      // wanted. Saying `true` is also the truth — every endpoint here is one the router serves.
      addRoute: true,
    })
}

/**
 * A door, as the five methods behind it.
 *
 * Curried so that `Own` and `Always` are inferred from the door's own answers and path pieces
 * while `E` is stated: a door knows its context type, and nothing can work it out from arguments.
 */
function doorway<E extends Env>() {
  return <Own extends Decided, Always extends z.ZodRawShape>(
      shows: Shows | undefined,
      gate: (db: Database) => readonly MiddlewareHandler[],
      own: Own,
      always: Always,
    ) =>
    (db: Database) => {
      const at = routesBehind<E, Own, Always>(endpointsBehind<E>(shows), gate(db), own, always)

      return {
        get: at('get'),
        post: at('post'),
        put: at('put'),
        patch: at('patch'),
        delete: at('delete'),
      }
    }
}

/**
 * What `.get` and the other four are: one route behind one door.
 *
 * Apart from {@link doorway} because they are two ideas — a door is five methods, and this is how
 * one declaration becomes one published route. Everything the door already knows is passed in;
 * everything else comes from the route itself.
 */
function routesBehind<E extends Env, Own extends Decided, Always extends z.ZodRawShape>(
  published: ReturnType<typeof endpointsBehind<E>>,
  middleware: readonly MiddlewareHandler[],
  own: Own,
  always: Always,
) {
  return (method: Method) =>
    <
      P extends z.ZodRawShape,
      A extends Answers,
      Q extends z.ZodRawShape = Record<never, never>,
      B extends z.ZodType | undefined = undefined,
    >(
      path: string,
      declared: Declared<E, P, P & Always, Q, B, A, Own>,
    ) =>
      published({
        route: createRoute({
          method,
          path,
          summary: declared.summary,
          middleware: [...middleware],
          request: {
            params: z.object({ ...always, ...declared.params }),
            query: z.object({ ...declared.query }),
            ...(declared.body === undefined ? {} : { body: takes(declared.body) }),
          } as unknown as Built<P & Always, Q, B, A, Own>['request'],
          responses: {
            ...own,
            // A body that is not the shape it claims is answered by the app itself, at every
            // route that takes one — see `api()`. Responses here so the contract says it wherever it
            // is true rather than wherever somebody remembered: before this, a quarter of the
            // routes that took a body did not declare it.
            ...(declared.body === undefined ? {} : MALFORMED_BODY),
            ...Object.fromEntries(
              Object.entries(declared.answers).map(([status, said]) => [
                status,
                typeof said === 'string' ? saysNothing(said) : said,
              ]),
            ),
          } as Own & Responses<A>,
        }),
        handler: declared.run as never,
        ...(declared.instead === undefined
          ? {}
          : { hook: insteadOfMalformed<E>(declared.instead) as never }),
      })
}

/** In a Space, which every door below this line reads out of the path. */
const IN_A_SPACE = { slug: z.string() }

/** A Space somebody may not have is answered as one that is not there, so a URL tells nobody. */
const NO_SUCH_SPACE = { 404: refusal('No such Space') }

/**
 * Nobody, which is the point: everything behind this is reachable by somebody with no way in yet.
 *
 * There is still a door — it is just an open one, and naming it says so on purpose rather than by
 * the absence of anything.
 */
export const anyone = doorway<Env>()(undefined, () => [], {}, {})

/** Somebody signed in, and that is all this asks. */
export const aPerson = doorway<{ Variables: Signed }>()(
  'browserSession',
  (db) => [requireSession(db)],
  BEHIND_A_SESSION,
  {},
)

/** Signed in and in this Space. Any member's job. */
export const aMember = doorway<{ Variables: Signed & InSpace }>()(
  'browserSession',
  (db) => [requireSession(db), requireMember(db)],
  { ...BEHIND_A_SESSION, ...NO_SUCH_SPACE },
  IN_A_SPACE,
)

/** In this Space, and allowed to do an owner's job here. */
export const anOwner = doorway<{ Variables: Signed & InSpace }>()(
  'browserSession',
  (db) => [requireSession(db), requireMember(db), requireOwner(db)],
  { ...BEHIND_A_SESSION, ...NO_SUCH_SPACE, 403: refusal('Only an owner can do this') },
  IN_A_SPACE,
)

/**
 * An owner's job, unless the person it is about is the person asking.
 *
 * The routes about one named person share this door rather than each mounting the gate, because
 * the pair has drifted apart before: softened on one and not the other, it left somebody able to
 * see what was theirs and unable to act on it — or, the way it happened, able to promote himself.
 */
export const anOwnerOrYourself = doorway<{ Variables: Signed & InSpace }>()(
  'browserSession',
  (db) => [requireSession(db), requireMember(db), requireOwnerOrYourself(db)],
  {
    ...BEHIND_A_SESSION,
    ...NO_SUCH_SPACE,
    403: refusal('Only an owner can do this to somebody else'),
  },
  IN_A_SPACE,
)

/** A live machine credential. Nobody signed in — a machine is not a person. */
export const aMachine = doorway<{ Variables: Attached }>()(
  'machineToken',
  (db) => [requireMachine(db)],
  BEHIND_A_MACHINE,
  {},
)

/**
 * An app that answers a request it could not parse the same way everywhere.
 *
 * A body that is not the shape it claims is not a product outcome — it is the same answer at
 * every route and never varies — so it is stated once here rather than at each one.
 */
export function api<E extends Env>(): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) return refused(c, MALFORMED)
      return undefined
    },
  })
}

/**
 * An app holding routes that came through different doors.
 *
 * One app and not one per door, because a route carries its own gate and its own context. What
 * used to force the split was that the app's `Variables` had to be the door's, so three doors
 * meant three sub-apps mounted at `/` and a reader counting brackets to find out which one a
 * route was in.
 */
export function mounted(routes: readonly { route: RouteConfig; handler: unknown }[]) {
  return api().openapiRoutes(routes)
}
