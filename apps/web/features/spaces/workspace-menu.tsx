/**
 * The Space switcher under the name at the top of the sidebar.
 *
 * It is a dialog rather than a menu in Notion's own accessibility tree: the top holds editable
 * identity, the middle holds navigation, and the emoji picker contains a search field. Pretending
 * that mixture is one ARIA menu would make its keyboard contract false.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { EmojiPicker } from 'frimousse'
import { useEffect, useRef, useState } from 'react'
import type { components } from '../../generated/api.ts'
import { meQuery } from '../identity/me.ts'
import { useSignOut } from '../identity/sign-out.tsx'
import { peopleIn } from './people.ts'
import { CheckIcon, PlusIcon, SettingsIcon } from './sidebar-icons.tsx'
import { useChangeSpaceEmoji } from './space.ts'

type Space = components['schemas']['Space']

function accountName(me: components['schemas']['Me'] | undefined): string {
  return (
    me?.credentials.find((credential) => credential.kind === 'email')?.address ??
    me?.displayName ??
    ''
  )
}

function memberSummary(count: number): string {
  return `${count} ${count === 1 ? 'member' : 'members'}`
}

function EmojiChooser({ slug, close }: { readonly slug: string; readonly close: () => void }) {
  const change = useChangeSpaceEmoji(slug)

  return (
    <div className="workspace-emoji-popover" role="dialog" aria-label="Choose a Space emoji">
      <EmojiPicker.Root
        className="workspace-emoji-picker"
        columns={8}
        locale="en"
        onEmojiSelect={({ emoji }) => {
          change.mutate({ params: { path: { slug } }, body: { emoji } }, { onSuccess: close })
        }}
      >
        <div className="workspace-emoji-toolbar">
          <EmojiPicker.Search autoFocus placeholder="Search emoji" aria-label="Search emoji" />
          <EmojiPicker.SkinToneSelector aria-label="Change skin tone" />
        </div>
        <EmojiPicker.Viewport>
          <EmojiPicker.Loading>Loading…</EmojiPicker.Loading>
          <EmojiPicker.Empty>No emoji found.</EmojiPicker.Empty>
          <EmojiPicker.List />
        </EmojiPicker.Viewport>
      </EmojiPicker.Root>
      {change.isError && <p role="alert">Could not change the emoji. Try again.</p>}
    </div>
  )
}

export function WorkspaceMenu({
  space,
  close,
}: {
  readonly space: Space
  readonly close: () => void
}) {
  const me = useQuery(meQuery)
  const people = useQuery(peopleIn(space.slug))
  const leave = useSignOut()
  const emojiControl = useRef<HTMLButtonElement>(null)
  const [choosingEmoji, setChoosingEmoji] = useState(false)
  const yours = people.data?.find((member) => member.you)
  const canChangeIdentity = yours?.role === 'owner'

  useEffect(() => {
    emojiControl.current?.focus()
  }, [])

  return (
    <div className="workspace-menu" role="dialog" aria-label={`${space.displayName} menu`}>
      <div className="workspace-menu-space">
        <button
          ref={emojiControl}
          className="workspace-menu-emoji"
          type="button"
          aria-label="Change Space emoji"
          aria-haspopup="dialog"
          aria-expanded={choosingEmoji}
          disabled={!canChangeIdentity}
          onClick={() => {
            setChoosingEmoji((open) => !open)
          }}
        >
          {space.emoji}
        </button>
        <span className="workspace-menu-space-copy">
          <strong>{space.displayName}</strong>
          <span>{memberSummary(people.data?.length ?? 0)}</span>
        </span>
      </div>

      {choosingEmoji && (
        <EmojiChooser
          slug={space.slug}
          close={() => {
            setChoosingEmoji(false)
          }}
        />
      )}

      <div className="workspace-menu-divider" />
      <div className="workspace-menu-actions">
        {/* Deliberately only the button in this slice. Disabled is more honest than sending
            somebody to account settings and calling it Workspace settings. */}
        <button type="button" disabled>
          <SettingsIcon />
          <span>Settings</span>
        </button>
      </div>

      <div className="workspace-menu-divider" />
      <div className="workspace-menu-account">
        <p>{accountName(me.data)}</p>
        <ul>
          {(me.data?.spaces ?? []).map((one) => (
            <li key={one.id}>
              <Link to="/s/$slug" params={{ slug: one.slug }} onClick={close}>
                <span className="workspace-menu-row-emoji">{one.emoji}</span>
                <span>{one.displayName}</span>
                {one.id === space.id && <CheckIcon />}
              </Link>
            </li>
          ))}
          <li>
            <Link to="/onboarding" onClick={close}>
              <PlusIcon />
              <span>New Space</span>
            </Link>
          </li>
        </ul>
      </div>

      <div className="workspace-menu-divider" />
      <button
        className="workspace-menu-logout"
        type="button"
        disabled={leave.isPending}
        onClick={() => {
          leave.mutate()
        }}
      >
        {leave.isError ? 'Could not log out' : 'Log out'}
      </button>
    </div>
  )
}
