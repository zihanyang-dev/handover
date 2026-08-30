/**
 * The links that let somebody into this Space.
 *
 * Beside the people they let in, because that is the question they answer — but their own
 * section, because a link has a lifetime and a secret and a person does not. The whole of a link
 * is readable exactly once, at the moment it is made; the list afterwards never carries it again,
 * and nothing here caches it.
 */

import { useQuery } from '@tanstack/react-query'
import { Link45deg } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import { Copy } from '../../components/ui/copy.tsx'
import { linksInto, useMakeLink, useStopLink } from './invitations.ts'

/** The read itself, named so the section and the list below it cannot describe it differently. */
function useLinks(slug: string) {
  return useQuery(linksInto(slug))
}

export function InvitationLinks({ slug }: { readonly slug: string }) {
  const links = useLinks(slug)
  const make = useMakeLink(slug)

  return (
    <section className="mb-9 border-b border-panel-line pb-8" aria-labelledby="invite-link-title">
      <div className="flex items-center justify-between gap-6 max-sm:flex-col max-sm:items-stretch max-sm:gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2
            id="invite-link-title"
            className="m-0 text-[14px] leading-5 font-medium text-panel-ink"
          >
            Invite link
          </h2>
          <p className="m-0 max-w-[560px] text-[13px] leading-[18px] text-panel-ink-muted">
            Anyone with this link can join. Stop it as soon as it is no longer needed.
          </p>
        </div>
        <button
          className="h-7 shrink-0 rounded-[6px] border-0 bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          type="button"
          disabled={make.isPending}
          onClick={() => {
            make.mutate({ params: { path: { slug } } })
          }}
        >
          {make.isPending ? 'Creating…' : 'Create invite link'}
        </button>
      </div>
      {make.data !== undefined && <MadeLink link={make.data.link} />}
      {make.isError && (
        <p className="mt-3 text-[13px] text-panel-danger" role="alert">
          {whyThereIsNoLink(make.error)}
        </p>
      )}
      <OpenLinks slug={slug} links={links} />
    </section>
  )
}

function MadeLink({ link }: { readonly link: string }) {
  return (
    <div
      className="mt-4 rounded-[8px] border border-panel-notice-line bg-panel-notice p-3"
      role="status"
    >
      <p className="text-[13px] leading-[18px] font-medium text-panel-ink">
        This is the only time the full link will be shown.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          className="h-8 min-w-0 grow rounded-[5px] border border-panel-line-firm bg-white px-2 text-[13px] text-panel-ink-body focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          aria-label="New invite link"
          value={link}
          readOnly
        />
        <Copy text={link} what="link" label />
      </div>
    </div>
  )
}

/** Named reasons come from `invitation-api.ts` and the door in `middleware.ts`. */
function whyThereIsNoLink(thrown: unknown): string {
  if (reasonOf(thrown) === 'not-an-owner') return 'Only an owner can create an invite link.'

  return 'That could not be sent. Try again.'
}

/**
 * The links that still work.
 *
 * Handed the read itself rather than three booleans off it: pending, failed and the answer are
 * one fact with three shapes, and as separate props there were eight of them, five impossible.
 */
function OpenLinks({
  slug,
  links,
}: {
  readonly slug: string
  readonly links: ReturnType<typeof useLinks>
}) {
  const stop = useStopLink(slug)

  if (links.isPending)
    return <p className="mt-4 text-[13px] text-panel-ink-muted">Reading links…</p>
  if (links.isError)
    return <p className="mt-4 text-[13px] text-panel-danger">Could not read invite links.</p>
  if (links.data.length === 0) return null

  return (
    <ul className="mt-4 list-none divide-y divide-panel-line p-0" aria-label="Active invite links">
      {links.data.map((link) => (
        <li className="flex min-h-10 items-center gap-3 py-2" key={link.id}>
          <Link45deg className="shrink-0 text-panel-ink-muted" aria-hidden />
          <span className="min-w-0 grow text-[13px] text-panel-ink-soft">
            Expires {shortDate(link.expiresAt)}
          </span>
          <button
            className="h-7 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-panel-danger-quiet hover:bg-panel-danger-wash focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            type="button"
            onClick={() => {
              stop.mutate({ params: { path: { slug, id: link.id } } })
            }}
          >
            Stop link
          </button>
        </li>
      ))}
    </ul>
  )
}

function shortDate(at: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(at))
}
