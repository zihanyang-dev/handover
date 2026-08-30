/**
 * The first step: where things will happen.
 *
 * Somebody with Spaces is offered them and goes straight in — the steps that remain are not
 * theirs to walk again. Somebody with none is making one right away: the form asks only for the
 * Space name and shows what its address will be.
 */

import { normalizeSlug } from '@handover/universal'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, Plus, X } from 'react-bootstrap-icons'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import { FieldError } from '../../components/ui/field-error.tsx'
import { Arrival } from '../identity/arrival.tsx'
import { ME, meQuery, type Me } from '../identity/me.ts'
import { SpaceEmojiPicker } from '../spaces/emoji-picker.tsx'
import { spaceRefusal } from '../spaces/refusal.ts'
import { STEP_EXIT_MS, Steps } from './steps.tsx'

function spaceFormPresentation(embedded: boolean, hasSpaces: boolean) {
  if (embedded) return { className: 'stack-tight space-create-form', autoFocus: false }
  return { className: 'stack-tight', autoFocus: !hasSpaces }
}

function SpaceFormHeading({ embedded }: { readonly embedded: boolean }) {
  if (embedded) return null
  return (
    <div className="auth-head">
      <h1>Name your Space</h1>
    </div>
  )
}

function SpaceEmojiField({
  emoji,
  choose,
}: {
  readonly emoji: string
  readonly choose: (emoji: string) => void
}) {
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLButtonElement>(null)

  return (
    <div className="space-create-emoji-field">
      <button
        ref={control}
        className="space-create-emoji"
        type="button"
        aria-label={`Choose Space emoji, currently ${emoji}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((shown) => !shown)
        }}
      >
        {emoji}
      </button>
      {open && (
        <div
          className="space-create-emoji-popover"
          role="dialog"
          aria-label="Choose a Space emoji"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            setOpen(false)
            control.current?.focus()
          }}
        >
          <SpaceEmojiPicker
            choose={(chosen) => {
              choose(chosen)
              setOpen(false)
              control.current?.focus()
            }}
          />
        </div>
      )}
    </div>
  )
}

/** One Space name, with its address appearing as it is typed. */
function MakeSpace({
  me,
  onMade,
  embedded = false,
  active = true,
}: {
  readonly me: Me
  readonly onMade: (slug: string) => void
  readonly embedded?: boolean
  readonly active?: boolean
}) {
  const client = useQueryClient()
  const spaceField = useId()
  const urlField = useId()
  const error = `${spaceField}-error`
  const [space, setSpace] = useState('')
  const [emoji, setEmoji] = useState('🏠')
  const presentation = spaceFormPresentation(embedded, me.spaces.length > 0)
  const slug = normalizeSlug(space)
  // This is for a person to read, not an HTTP client to serialize. URL.href percent-encodes
  // perfectly valid Unicode slugs and turns a name such as 你好 into noise.
  const spaceUrl = slug === null ? '' : `${globalThis.location.origin}/s/${slug}`

  const begin = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/spaces', {
        body: {
          displayName: space.trim(),
          emoji,
          requestKey: retryKey(`space:${space.trim()}`),
        },
      })
      // The refusal itself, not a sentence with it stringified inside. `409` carries a free
      // address in `suggestion`, and that has to survive being thrown.
      if (data === undefined) throw error
      retryKeyDone(`space:${space.trim()}`)
      return data
    },
    onSuccess: (made) => {
      // The create response is the authoritative new Space. Put it straight into /me instead of
      // invalidating and making the Host route wait behind another copy of the same read.
      client.setQueryData<Me>(ME, (current) => {
        const person = current ?? me
        return {
          ...person,
          spaces: [...person.spaces.filter((space) => space.slug !== made.slug), made],
        }
      })
      onMade(made.slug)
    },
  })

  const refused = spaceRefusal(begin.error)
  // Two different things to say. A refusal has words of its own; a call that never arrived has
  // none, and saying nothing at all would leave a button that looks like it did nothing.
  const said = refused ?? (begin.isError ? 'That could not be sent. Try again shortly.' : undefined)

  return (
    <>
      <SpaceFormHeading embedded={embedded} />

      <form
        className={presentation.className}
        onSubmit={(event) => {
          event.preventDefault()
          begin.mutate()
        }}
      >
        <div className="space-create-name-field">
          <label className="label" htmlFor={spaceField}>
            Space name
          </label>
          <div className="space-create-name-control">
            <SpaceEmojiField key={active ? 'active' : 'inactive'} emoji={emoji} choose={setEmoji} />
            <input
              id={spaceField}
              className="field"
              autoFocus={presentation.autoFocus}
              placeholder="Acme"
              aria-invalid={said !== undefined}
              aria-describedby={error}
              value={space}
              onChange={(event) => {
                setSpace(event.target.value)
                begin.reset()
              }}
            />
          </div>
        </div>
        <label className="label" htmlFor={urlField}>
          Space URL
        </label>
        <input
          id={urlField}
          className="field space-url"
          type="url"
          readOnly
          disabled
          placeholder="Its URL appears here as you type."
          value={spaceUrl}
        />

        {/* Always here so an error arriving does not shift the form, but only an alert when it
            actually says something. */}
        <FieldError id={error} shown={said !== undefined}>
          {said ?? null}
        </FieldError>

        <button
          className="button button-primary"
          type="submit"
          disabled={slug === null || begin.isPending}
        >
          <span className="button-label">{begin.isPending ? 'Making…' : 'Continue'}</span>
        </button>
      </form>
    </>
  )
}

/** A non-modal bottom sheet: it rises from the viewport edge and leaves the Spaces readable. */
function SpaceCreateDrawer({
  open,
  me,
  onClose,
  onMade,
}: {
  readonly open: boolean
  readonly me: Me
  readonly onClose: () => void
  readonly onMade: (slug: string) => void
}) {
  const drawer = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      drawer.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
    })
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      const surface = drawer.current?.querySelector('.space-create-disclosure')
      if (surface?.contains(target)) return
      if (target instanceof Element && target.closest('[aria-controls="new-space-form"]') !== null)
        return
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('pointerdown', closeFromOutside)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('pointerdown', closeFromOutside)
      const opener = returnFocus.current
      requestAnimationFrame(() => {
        if (opener?.isConnected === true) opener.focus()
      })
    }
  }, [onClose, open])

  return (
    <div
      ref={drawer}
      id="new-space-form"
      className="space-create-drawer t-panel-slide"
      data-open={open}
      role="region"
      aria-label="New Space drawer"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="space-create-disclosure">
        <span className="space-create-drawer-handle" aria-hidden />
        <div className="space-create-drawer-head">
          <strong>New Space</strong>
          <button type="button" aria-label="Close New Space" onClick={onClose}>
            <X size={20} aria-hidden />
          </button>
        </div>
        <MakeSpace me={me} embedded active={open} onMade={onMade} />
      </div>
    </div>
  )
}

/** New and existing Spaces in one hierarchy: make is primary, the known places stay compact. */
function PickSpace({
  me,
  making,
  onPick,
  onMake,
  onMade,
}: {
  readonly me: Me
  readonly making: boolean
  readonly onPick: (slug: string) => void
  readonly onMake: () => void
  readonly onMade: (slug: string) => void
}) {
  const spaces = me.spaces
  const canStack = spaces.length > 1
  const [spacesExpanded, setSpacesExpanded] = useState(!canStack)
  const expandedDeckHeight = `${String(spaces.length * 4.53125 - 0.5)}rem`
  return (
    <>
      <div className="auth-head">
        <h1>Choose a Space</h1>
      </div>

      <div className="space-picker">
        <button
          className="space-choice space-choice-new"
          type="button"
          aria-controls="new-space-form"
          aria-expanded={making}
          onClick={onMake}
        >
          <span className="space-choice-icon" aria-hidden>
            <Plus size={20} />
          </span>
          <span className="space-choice-copy">
            <strong>New Space</strong>
          </span>
        </button>

        <SpaceCreateDrawer open={making} me={me} onClose={onMake} onMade={onMade} />

        <div className="space-picker-label-row">
          <p className="space-picker-label">Your Spaces</p>
          {canStack && (
            <button
              className="space-spread-toggle"
              type="button"
              aria-controls="space-choice-list"
              aria-expanded={spacesExpanded}
              aria-label={spacesExpanded ? 'Stack Spaces' : 'Spread Spaces'}
              onClick={() => {
                setSpacesExpanded((expanded) => !expanded)
              }}
            >
              <ChevronRight aria-hidden />
            </button>
          )}
        </div>

        <div
          className="space-choice-deck"
          data-expanded={spacesExpanded}
          style={{ height: spacesExpanded ? expandedDeckHeight : '5.78125rem' }}
        >
          <div
            id="space-choice-list"
            className="space-choice-list"
            data-expanded={spacesExpanded}
            aria-hidden={!spacesExpanded}
            inert={!spacesExpanded}
          >
            {spaces.map((space) => (
              <div key={space.id} className="space-choice-position">
                <button
                  className="space-choice"
                  type="button"
                  aria-label={`Open ${space.displayName}`}
                  onClick={() => {
                    onPick(space.slug)
                  }}
                >
                  <span className="space-choice-existing-emoji" aria-hidden>
                    {space.emoji}
                  </span>
                  <span className="space-choice-copy">
                    <strong>{space.displayName}</strong>
                    <small>/s/{space.slug}</small>
                  </span>
                  <ChevronRight className="space-choice-arrow" aria-hidden />
                </button>
              </div>
            ))}
          </div>

          {canStack && !spacesExpanded && (
            <button
              className="space-choice-deck-open"
              type="button"
              aria-label={`Spread ${spaces.length} Spaces`}
              onClick={() => {
                setSpacesExpanded(true)
              }}
            />
          )}
        </div>
      </div>
    </>
  )
}

function useArrivalHadSpaces(me: Me | undefined): boolean | undefined {
  const [choosing, setChoosing] = useState<boolean>()
  if (me !== undefined && choosing === undefined) setChoosing(me.spaces.length > 0)
  return choosing
}

export function Onboarding({ result }: { readonly result: string | undefined }) {
  const me = useQuery(meQuery)
  const [making, setMaking] = useState(false)
  const toggleMaking = useCallback(() => {
    setMaking((open) => !open)
  }, [])
  /** Where this step ends: an existing Space to enter, or a made one to put a machine on. */
  const [leave, setLeave] = useState<{ to: 'space' | 'host'; slug: string }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const navigate = useNavigate()

  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  // Which entrance somebody arrived through does not change when creating updates /me. Deriving
  // this on every render replaced the current form with the other entrance for one paint before
  // the Machine route mounted — the flash a person saw after Continue.
  const choosing = useArrivalHadSpaces(me.data)

  // The Host route owns the second half of the rail. Flashing success here for one paint changed
  // the rider's face immediately before that route mounted it in its working state.
  const done = leave?.to === 'space'

  useEffect(() => {
    if (leave === undefined) return

    // The Host step mounts at the midpoint and carries the rider forward itself. Waiting here as
    // well made a completed create feel stuck before the route even began to load.
    if (leave.to === 'host') {
      void navigate({ to: '/onboarding/host', search: { s: leave.slug } })
      return
    }

    timer.current = setTimeout(() => {
      void navigate({ to: '/s/$slug', params: { slug: leave.slug } })
    }, STEP_EXIT_MS)
  }, [leave, navigate])

  return (
    <main className="auth onboarding-page">
      <div className="onboarding-shell">
        <Steps step={1} done={done} mark={done ? 'success' : 'thinking'} />

        <section className="onboarding-content onboarding-step-card">
          <Arrival result={result} />

          {me.isPending && (
            <p className="empty" role="status">
              Looking…
            </p>
          )}

          {me.isError && (
            <p className="said said-bad" role="alert">
              Could not read your Spaces. Try again in a moment.
            </p>
          )}

          {me.isSuccess && choosing && (
            <PickSpace
              me={me.data}
              making={making}
              onPick={(slug) => {
                setLeave({ to: 'space', slug })
              }}
              onMake={toggleMaking}
              onMade={(slug) => {
                setLeave({ to: 'host', slug })
              }}
            />
          )}

          {me.isSuccess && !choosing && (
            <MakeSpace
              me={me.data}
              onMade={(slug) => {
                setLeave({ to: 'host', slug })
              }}
            />
          )}
        </section>
      </div>
    </main>
  )
}
