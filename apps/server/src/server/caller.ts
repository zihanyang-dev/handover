/**
 * Who is calling, for the things that have to be counted per caller.
 *
 * Before anybody signs in there is no account to count against, so the only identity a public
 * endpoint has is the connection itself. Which is fine — as long as it is really the connection,
 * and not a header the caller wrote.
 */

import { getConnInfo } from '@hono/node-server/conninfo'
import { createHash } from 'node:crypto'
import type { Context } from 'hono'

/**
 * The caller's address, as far as this deployment can honestly tell.
 *
 * `X-Forwarded-For` is a list each proxy appends to, so the entry our own proxy wrote is the one
 * `hops` from the right — everything to the left of it was written by whoever was calling and can
 * say anything at all. With no proxies configured the header is ignored entirely, because an
 * unproxied deployment that read it would be counting a number the caller chose.
 */
export function callerAddress(c: Context, hops: number): string | null {
  if (hops > 0) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '').split(',').map((one) => one.trim())
    const ours = forwarded.at(-hops)

    return ours === undefined || ours === '' ? null : ours
  }

  try {
    return getConnInfo(c).remote.address ?? null
  } catch {
    // Not served by the Node adapter — a request made in-process, or another runtime entirely.
    // Nobody to count, which is the honest answer: the alternative is a request that fails
    // outright because it could not be attributed.
    return null
  }
}

/**
 * The caller, in the one form it is stored in.
 *
 * A hash, because what is wanted is "the same caller as before" and nothing else. An address is
 * somebody's location; a table of them is a log of where people sign in from, kept for as long as
 * the rows live.
 */
export function callerId(address: string | null): string | null {
  return address === null ? null : createHash('sha256').update(address).digest('hex')
}
