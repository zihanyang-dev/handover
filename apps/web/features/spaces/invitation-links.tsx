import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Check2, Clipboard, Link45deg } from 'react-bootstrap-icons'
import type { components } from '../../generated/api.ts'
import { linksInto, useMakeLink, useStopLink } from './invitations.ts'

/** One-time links belong beside the people they let in, but have their own lifetime and secret. */
export function InvitationLinks({ slug }: { readonly slug: string }) {
  const links = useQuery(linksInto(slug))
  const make = useMakeLink(slug)
  const stop = useStopLink(slug)

  return (
    <section className="mb-9 border-b border-[#e9e8e6] pb-8" aria-labelledby="invite-link-title">
      <div className="flex items-start justify-between gap-6 max-sm:flex-col max-sm:gap-3">
        <div>
          <h2 id="invite-link-title" className="text-[14px] leading-5 font-medium text-[#373633]">
            Invite link
          </h2>
          <p className="mt-0.5 max-w-[560px] text-[13px] leading-[18px] text-[#777570]">
            Anyone with this link can join. Stop it as soon as it is no longer needed.
          </p>
        </div>
        <button
          className="h-8 shrink-0 rounded-[6px] border-0 bg-[#2383e2] px-3 text-[14px] font-medium text-white hover:bg-[#1f75ca] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0075de]"
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
        <p className="mt-3 text-[13px] text-[#b42318]" role="alert">
          Only an owner can create an invite link.
        </p>
      )}
      <OpenLinks
        pending={links.isPending}
        failed={links.isError}
        links={links.data}
        stop={stop}
        slug={slug}
      />
    </section>
  )
}

function MadeLink({ link }: { readonly link: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="mt-4 rounded-[8px] border border-[#d9e8f8] bg-[#f4f9fe] p-3" role="status">
      <p className="text-[13px] leading-[18px] font-medium text-[#2f2e2b]">
        This is the only time the full link will be shown.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          className="h-8 min-w-0 grow rounded-[5px] border border-[#d7d5d2] bg-white px-2 text-[13px] text-[#494844] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
          aria-label="New invite link"
          value={link}
          readOnly
        />
        <button
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-[#d7d5d2] bg-white px-3 text-[13px] font-medium text-[#373633] hover:bg-[#f5f4f2] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(link)
            setCopied(true)
          }}
        >
          {copied ? <Check2 aria-hidden /> : <Clipboard aria-hidden />}
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  )
}

function OpenLinks({
  pending,
  failed,
  links,
  stop,
  slug,
}: {
  readonly pending: boolean
  readonly failed: boolean
  readonly links: readonly components['schemas']['OpenInvitation'][] | undefined
  readonly stop: ReturnType<typeof useStopLink>
  readonly slug: string
}) {
  if (pending) return <p className="mt-4 text-[13px] text-[#777570]">Reading links…</p>
  if (failed) return <p className="mt-4 text-[13px] text-[#b42318]">Could not read invite links.</p>
  if (links === undefined || links.length === 0) return null

  return (
    <ul className="mt-4 list-none divide-y divide-[#efeeec] p-0" aria-label="Active invite links">
      {links.map((link) => (
        <li className="flex min-h-10 items-center gap-3 py-2" key={link.id}>
          <Link45deg className="shrink-0 text-[#777570]" aria-hidden />
          <span className="min-w-0 grow text-[13px] text-[#5f5d59]">
            Expires {shortDate(link.expiresAt)}
          </span>
          <button
            className="h-7 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-[#9b2c2c] hover:bg-[#fdf0ef] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
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
