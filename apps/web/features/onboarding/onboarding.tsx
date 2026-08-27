/**
 * The first step: where things will happen.
 *
 * Somebody with Spaces is offered them and goes straight in — the steps that remain are not
 * theirs to walk again. Somebody with none is making one right away: the form asks only for the
 * workspace name and shows what its address will be.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, Plus, X } from 'react-bootstrap-icons'
import { normalizeSlug } from '@handover/universal'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import { Arrival } from '../identity/arrival.tsx'
import { ME, meQuery, type Me } from '../identity/me.ts'
import { spaceRefusal } from '../spaces/refusal.ts'

/** Long enough for the step to leave the screen, short enough that Continue still feels instant. */
const STEP_EXIT_MS = 260

function spaceFormPresentation(embedded: boolean, hasSpaces: boolean) {
  if (embedded) return { className: 'stack-tight space-create-form', autoFocus: false }
  return { className: 'stack-tight', autoFocus: !hasSpaces }
}

function SpaceFormHeading({ embedded }: { readonly embedded: boolean }) {
  if (embedded) return null
  return (
    <div className="auth-head">
      <h1>Name your workspace</h1>
      <p className="lede">Machines and agents gather here.</p>
    </div>
  )
}

/** One workspace name, with its address appearing as it is typed. */
function MakeSpace({
  me,
  onMade,
  embedded = false,
}: {
  readonly me: Me
  readonly onMade: (slug: string) => void
  readonly embedded?: boolean
}) {
  const client = useQueryClient()
  const spaceField = useId()
  const urlField = useId()
  const [space, setSpace] = useState('')
  const presentation = spaceFormPresentation(embedded, me.spaces.length > 0)
  const slug = normalizeSlug(space)
  // This is for a person to read, not an HTTP client to serialize. URL.href percent-encodes
  // perfectly valid Unicode slugs and turns a name such as 你好 into noise.
  const spaceUrl = slug === null ? '' : `${globalThis.location.origin}/s/${slug}`

  const begin = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/spaces', {
        body: { displayName: space.trim(), requestKey: retryKey(`space:${space.trim()}`) },
      })
      if (data === undefined) throw new Error(JSON.stringify(error))
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
        <label className="label" htmlFor={spaceField}>
          Workspace name
        </label>
        <input
          id={spaceField}
          className="field"
          autoFocus={presentation.autoFocus}
          placeholder="Acme"
          value={space}
          onChange={(event) => {
            setSpace(event.target.value)
            begin.reset()
          }}
        />
        <label className="label" htmlFor={urlField}>
          Workspace URL
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
            actually says something — an empty alert is a screen reader announcing nothing. */}
        <p
          className="auth-error"
          role={said === undefined ? undefined : 'alert'}
          data-shown={said !== undefined ? '' : undefined}
        >
          {said ?? null}
        </p>

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

  useEffect(() => {
    if (!open) return
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
        <MakeSpace me={me} embedded onMade={onMade} />
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

        <div className="space-choice-deck" data-expanded={spacesExpanded}>
          <motion.div
            layout
            id="space-choice-list"
            className="space-choice-list"
            data-expanded={spacesExpanded}
            aria-hidden={!spacesExpanded}
            inert={!spacesExpanded}
          >
            {spaces.map((space) => (
              <motion.div
                key={space.id}
                layout="position"
                className="space-choice-position"
                transition={{ layout: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } }}
              >
                <button
                  className="space-choice"
                  type="button"
                  aria-label={`Open ${space.displayName}`}
                  onClick={() => {
                    onPick(space.slug)
                  }}
                >
                  <span className="space-choice-copy">
                    <strong>{space.displayName}</strong>
                    <small>/s/{space.slug}</small>
                  </span>
                  <ChevronRight className="space-choice-arrow" aria-hidden />
                </button>
              </motion.div>
            ))}
          </motion.div>

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

export function Onboarding({ result }: { readonly result: string | undefined }) {
  const me = useQuery(meQuery)
  const [making, setMaking] = useState(false)
  /** Where this step ends: an existing Space to enter, or a made one to put a machine on. */
  /**
   * Which Space to go into, once the step has finished leaving the screen.
   *
   * Picked and just-made are the same thing on purpose. Making one used to send somebody to a
   * second step for connecting a machine, and that was a first-Space special case `prd.md` 01 ④
   * forbids — and since a machine belongs to a person, a new Space already has the machines its
   * maker connected. What is left of that step lives where it always belonged: a Space with
   * nothing that can run says so, and shows the command.
   */
  const [leave, setLeave] = useState<{ slug: string }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const navigate = useNavigate()

  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  const spaces = me.data?.spaces ?? []
  const choosing = spaces.length > 0

  useEffect(() => {
    if (leave === undefined) return

    timer.current = setTimeout(() => {
      void navigate({ to: '/s/$slug', params: { slug: leave.slug } })
    }, STEP_EXIT_MS)
  }, [leave, navigate])

  return (
    <main className="auth onboarding-page">
      <div className="onboarding-shell">
        <section className="onboarding-content">
          <Arrival result={result} />

          {me.isPending && <p className="empty">Looking…</p>}

          {me.isSuccess && choosing && (
            <PickSpace
              me={me.data}
              making={making}
              onPick={(slug) => {
                setLeave({ slug })
              }}
              onMake={() => {
                setMaking((open) => !open)
              }}
              onMade={(slug) => {
                setLeave({ slug })
              }}
            />
          )}

          {me.isSuccess && !choosing && (
            <MakeSpace
              me={me.data}
              onMade={(slug) => {
                setLeave({ slug })
              }}
            />
          )}
        </section>
      </div>
    </main>
  )
}
