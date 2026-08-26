/**
 * The first step: where things will happen.
 *
 * Somebody with Spaces is offered them and goes straight in — the steps that remain are not
 * theirs to walk again. Somebody with none is making one right away: their name is already here
 * from the way they signed in, so the form is mostly a Space's name and what its address will be.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import { normalizeSlug } from '@handover/universal'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import { Arrival } from '../identity/arrival.tsx'
import { ME, meQuery, type Me } from '../identity/me.ts'
import { spaceRefusal } from '../spaces/refusal.ts'
import { Steps } from './steps.tsx'

/** The name and the Space, one decision. The address appears as the name is typed. */
function NameAndSpace({
  me,
  onMade,
}: {
  readonly me: Me
  readonly onMade: (slug: string) => void
}) {
  const client = useQueryClient()
  const nameField = useId()
  const spaceField = useId()
  const [name, setName] = useState(me.displayName)
  const [space, setSpace] = useState('')
  const slug = normalizeSlug(space)

  const begin = useMutation({
    mutationFn: async () => {
      const renamed = name.trim()
      if (renamed !== me.displayName) await api.PATCH('/me', { body: { displayName: renamed } })
      const { data, error } = await api.POST('/spaces', {
        body: { displayName: space.trim(), requestKey: retryKey(`space:${space.trim()}`) },
      })
      if (data === undefined) throw new Error(JSON.stringify(error))
      retryKeyDone(`space:${space.trim()}`)
      return data
    },
    onSuccess: (made) => {
      void client.invalidateQueries({ queryKey: ME })
      // Handed up: the parent sweeps the bar and navigates, out of the mutation's call stack.
      onMade(made.slug)
    },
  })

  const refused = spaceRefusal(begin.error)

  return (
    <>
      <div className="auth-head">
        <h1>Make your Space</h1>
        <p className="lede">A Space is where your machines and agents gather.</p>
      </div>

      <form
        className="stack-tight"
        onSubmit={(event) => {
          event.preventDefault()
          begin.mutate()
        }}
      >
        <label className="label" htmlFor={nameField}>
          Your name
        </label>
        <input
          id={nameField}
          className="field"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />

        <label className="label" htmlFor={spaceField}>
          Space
        </label>
        <input
          id={spaceField}
          className="field"
          autoFocus={me.spaces.length === 0}
          placeholder="Acme"
          value={space}
          onChange={(event) => {
            setSpace(event.target.value)
            begin.reset()
          }}
        />
        <p className="preview">
          {space.trim() === '' ? (
            'Its address appears here as you type.'
          ) : slug === null ? (
            'That name has no address in it.'
          ) : (
            <>
              <span>/s/</span>
              <strong>{slug}</strong>
            </>
          )}
        </p>

        <p className="auth-error" data-shown={refused !== undefined ? '' : undefined}>
          {refused ?? null}
        </p>

        <button
          className="button button-primary"
          type="submit"
          disabled={slug === null || name.trim() === '' || begin.isPending}
        >
          <span className="button-label">{begin.isPending ? 'Making…' : 'Continue'}</span>
        </button>
      </form>
    </>
  )
}

/** The Spaces somebody already has, as the ways in; making another is the quiet option. */
function PickSpace({
  spaces,
  onPick,
  onMake,
}: {
  readonly spaces: Me['spaces']
  readonly onPick: (slug: string) => void
  readonly onMake: () => void
}) {
  return (
    <>
      <div className="auth-head">
        <h1>Where to?</h1>
        <p className="lede">Pick a Space, or make a new one.</p>
      </div>

      <div className="auth-ways">
        {spaces.map((space) => (
          <button
            key={space.id}
            className="button button-secondary"
            type="button"
            onClick={() => {
              onPick(space.slug)
            }}
          >
            <span className="button-label">{space.displayName}</span>
          </button>
        ))}
      </div>

      <button className="button button-quiet auth-new-space" type="button" onClick={onMake}>
        <span className="button-label">New space</span>
      </button>
    </>
  )
}

export function Onboarding({ result }: { readonly result: string | undefined }) {
  const me = useQuery(meQuery)
  const [making, setMaking] = useState(false)
  /** Where this step ends: an existing Space to enter, or a made one to put a machine on. */
  const [leave, setLeave] = useState<{ to: 'space' | 'host'; slug: string }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const navigate = useNavigate()

  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  const spaces = me.data?.spaces ?? []
  const choosing = spaces.length > 0 && !making
  const done = leave !== undefined

  useEffect(() => {
    if (leave === undefined) return
    timer.current = setTimeout(() => {
      void (leave.to === 'space'
        ? navigate({ to: '/s/$slug', params: { slug: leave.slug } })
        : navigate({ to: '/onboarding/host', search: { s: leave.slug } }))
    }, 520)
  }, [leave, navigate])

  return (
    <main className="auth">
      <div className="auth-stack">
        <Steps step={1} done={done} mark={done ? 'success' : 'thinking'} />
        <Arrival result={result} />

        {me.isPending && <p className="empty">Looking…</p>}

        {me.isSuccess && choosing && (
          <PickSpace
            spaces={spaces}
            onPick={(slug) => {
              setLeave({ to: 'space', slug })
            }}
            onMake={() => {
              setMaking(true)
            }}
          />
        )}

        {me.isSuccess && !choosing && (
          <NameAndSpace
            // isSuccess guards this; the type does not learn that through the JSX.
            me={me.data as Me}
            onMade={(slug) => {
              setLeave({ to: 'host', slug })
            }}
          />
        )}
      </div>
    </main>
  )
}
