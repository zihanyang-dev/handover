/**
 * The one link that lets somebody into this Space.
 *
 * Beside the people it lets in, because that is the question it answers — but its own section,
 * because a link has a lifetime and a secret and a person does not. Its whole address is readable
 * exactly once, at the moment it is made. Replacing it stops the old one before revealing the new
 * one, and nothing here caches either secret after this dialog closes.
 */

import { useQuery } from '@tanstack/react-query'
import { Link45deg } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import { Copy } from '../../components/ui/copy.tsx'
import { linksInto, useMakeLink, useStopLink } from './invitations.ts'

/** The read itself, named so the section and the row below it cannot describe it differently. */
function useLinks(slug: string) {
  return useQuery(linksInto(slug))
}

export type RevealedInvitation = {
  readonly id: string
  readonly link: string
  readonly expiresAt: string
}

function createLabel(pending: boolean, hasLink: boolean): string {
  if (pending) return hasLink ? 'Replacing…' : 'Creating…'
  return hasLink ? 'Replace link' : 'Create invite link'
}

export function InvitationLinks({
  slug,
  revealed,
  reveal,
  forget,
}: {
  readonly slug: string
  readonly revealed: RevealedInvitation | undefined
  readonly reveal: (invitation: RevealedInvitation) => void
  readonly forget: () => void
}) {
  const links = useLinks(slug)
  const make = useMakeLink(slug)

  return (
    <section className="mb-12" aria-labelledby="invite-link-title">
      <div className="flex items-center justify-between gap-6">
        <h2 id="invite-link-title" className="m-0 text-[14px] leading-5 font-medium text-panel-ink">
          Invite link
        </h2>
        <button
          className="h-7 shrink-0 cursor-pointer rounded-[6px] border-0 bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          type="button"
          disabled={make.isPending}
          onClick={() => {
            make.mutate(
              { params: { path: { slug } } },
              {
                onSuccess: (invitation) => {
                  reveal(invitation)
                },
              },
            )
          }}
        >
          {createLabel(make.isPending, revealed !== undefined || (links.data?.length ?? 0) > 0)}
        </button>
      </div>
      {make.isError && (
        <p className="mt-3 text-[13px] text-panel-danger" role="alert">
          {whyThereIsNoLink(make.error)}
        </p>
      )}
      <OpenLink slug={slug} links={links} revealed={revealed} forget={forget} />
    </section>
  )
}

/** Named reasons come from `invitation-api.ts` and the door in `middleware.ts`. */
function whyThereIsNoLink(thrown: unknown): string {
  if (reasonOf(thrown) === 'not-an-owner') return 'Only an owner can create an invite link.'

  return 'That could not be sent. Try again.'
}

/**
 * The link that still works.
 *
 * Handed the read itself rather than three booleans off it: pending, failed and the answer are
 * one fact with three shapes, and as separate props there were eight of them, five impossible.
 */
function OpenLink({
  slug,
  links,
  revealed,
  forget,
}: {
  readonly slug: string
  readonly links: ReturnType<typeof useLinks>
  readonly revealed: RevealedInvitation | undefined
  readonly forget: () => void
}) {
  if (revealed !== undefined)
    return <ActiveLink slug={slug} link={revealed} full={revealed.link} forget={forget} />
  if (links.isPending)
    return (
      <p className="mt-4 text-[13px] text-panel-ink-muted" role="status">
        Reading links…
      </p>
    )
  if (links.isError)
    return (
      <p className="mt-4 text-[13px] text-panel-danger" role="alert">
        Could not read invite link.
      </p>
    )

  const [link] = links.data
  if (link === undefined) return null
  return <ActiveLink slug={slug} link={link} />
}

function ActiveLink({
  slug,
  link,
  full,
  forget,
}: {
  readonly slug: string
  readonly link: { readonly id: string; readonly expiresAt: string }
  readonly full?: string
  readonly forget?: () => void
}) {
  return (
    <fieldset
      className="mt-3 flex min-h-10 min-w-0 items-center gap-2 border-0 px-1 py-1"
      aria-label="Active invite link"
    >
      <Link45deg className="shrink-0 text-panel-ink-muted" aria-hidden />
      {full === undefined ? (
        <span className="min-w-0 grow text-[13px] text-panel-ink-soft">Invite link active</span>
      ) : (
        <span className="min-w-0 grow truncate text-[13px] text-panel-ink-body" title={full}>
          {full}
        </span>
      )}
      {full !== undefined && <Copy text={full} what="link" />}
      <span className="shrink-0 text-[12px] text-panel-ink-quiet">
        Expires {shortDate(link.expiresAt)}
      </span>
      <DisableLink slug={slug} linkId={link.id} forget={forget} />
    </fieldset>
  )
}

function DisableLink({
  slug,
  linkId,
  forget,
}: {
  readonly slug: string
  readonly linkId: string
  readonly forget: (() => void) | undefined
}) {
  const stop = useStopLink(slug)

  return (
    <button
      className="h-7 shrink-0 rounded-[5px] border-0 bg-transparent px-2 text-[12px] font-medium text-panel-danger-quiet hover:bg-panel-danger-wash disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      type="button"
      aria-label="Disable invite link"
      disabled={stop.isPending}
      onClick={() => {
        stop.mutate(
          { params: { path: { slug, id: linkId } } },
          {
            onSuccess: () => {
              forget?.()
            },
          },
        )
      }}
    >
      Disable
    </button>
  )
}

function shortDate(at: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(at))
}
