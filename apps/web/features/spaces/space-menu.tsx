/**
 * The Space switcher under the name at the top of the sidebar.
 *
 * It is a dialog rather than a menu in Notion's own accessibility tree: the top holds editable
 * identity, the middle holds navigation, and the emoji picker contains a search field. Pretending
 * that mixture is one ARIA menu would make its keyboard contract false.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { components } from '../../generated/api.ts'
import { nameUnlessAddress } from '../identity/account-name.ts'
import { meQuery } from '../identity/me.ts'
import { useSignOut } from '../identity/sign-out.tsx'
import { SpaceEmojiPicker } from './emoji-picker.tsx'
import { peopleIn } from './people.ts'
import { CheckIcon, PlusIcon, SettingsIcon } from './sidebar-icons.tsx'
import type { SettingsSection } from './space-settings.tsx'
import { useChangeSpaceEmoji } from './space.ts'

type Space = components['schemas']['Space']

/** The chosen name in this compact menu, without turning an email fallback into a label. */
function accountName(me: components['schemas']['Me'] | undefined): string | undefined {
  if (me === undefined) return undefined
  return nameUnlessAddress(me.displayName) ?? 'Account'
}

/** How many people are here, once that is known. A Space always has one, so nought is never true. */
function memberSummary(people: readonly unknown[] | undefined): string | undefined {
  if (people === undefined) return undefined

  return `${people.length} ${people.length === 1 ? 'member' : 'members'}`
}

function EmojiChooser({ slug, close }: { readonly slug: string; readonly close: () => void }) {
  const change = useChangeSpaceEmoji(slug)

  return (
    <div className="space-emoji-popover" role="dialog" aria-label="Choose a Space emoji">
      <SpaceEmojiPicker
        choose={(emoji) => {
          change.mutate({ params: { path: { slug } }, body: { emoji } }, { onSuccess: close })
        }}
      />
      {change.isError && <p role="alert">Could not change the emoji. Try again.</p>}
    </div>
  )
}

export function SpaceMenu({
  space,
  close,
  openSettings,
}: {
  readonly space: Space
  readonly close: () => void
  readonly openSettings: (section: SettingsSection) => void
}) {
  const me = useQuery(meQuery)
  const people = useQuery(peopleIn(space.slug))
  const signOut = useSignOut()
  const emojiControl = useRef<HTMLButtonElement>(null)
  const [choosingEmoji, setChoosingEmoji] = useState(false)
  const yours = people.data?.find((member) => member.you)
  const canChangeIdentity = yours?.role === 'owner'

  useEffect(() => {
    emojiControl.current?.focus()
  }, [])

  return (
    <div className="space-menu" role="dialog" aria-label={`${space.displayName} menu`}>
      <div className="space-menu-space">
        <button
          ref={emojiControl}
          className="space-menu-emoji"
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
        <span className="space-menu-space-copy">
          <strong>{space.displayName}</strong>
          <span>{memberSummary(people.data)}</span>
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

      <div className="space-menu-divider" />
      <div className="space-menu-actions">
        <button
          type="button"
          onClick={() => {
            openSettings('people')
          }}
        >
          <SettingsIcon />
          <span>Settings</span>
        </button>
      </div>

      <div className="space-menu-divider" />
      <div className="space-menu-account">
        <p>{accountName(me.data)}</p>
        <ul>
          {(me.data?.spaces ?? []).map((one) => (
            <li key={one.id}>
              <Link to="/s/$slug" params={{ slug: one.slug }} onClick={close}>
                <span className="space-menu-row-emoji">{one.emoji}</span>
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

      <div className="space-menu-divider" />
      <button
        className="space-menu-sign-out"
        type="button"
        disabled={signOut.isPending}
        onClick={() => {
          signOut.mutate()
        }}
      >
        {signOut.isError ? 'Could not sign out' : 'Sign out'}
      </button>
    </div>
  )
}
