/**
 * Making a Space.
 *
 * The address appears while the name is being typed, from the very function the server uses to
 * decide it. There is no preview endpoint and no second copy of the rule — what is shown here is
 * what the server will do, because it is the same code doing it.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { ExclamationCircleFill } from 'react-bootstrap-icons'
import { normalizeSlug } from '@handover/universal'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import { ME } from '../identity/me.ts'

/**
 * A refusal, carried out of the call that was refused.
 *
 * Its own error rather than the refusal folded into a message string: this is the one call whose
 * refusal has a second field, and a message that has to be parsed back would be parsed for every
 * failure — including the ones that are not refusals at all. A dropped connection rejects with
 * something nobody wrote, and reading that as a refusal turned this screen blank.
 */
class Refused extends Error {
  readonly suggestion: string | undefined

  constructor(suggestion: string | undefined) {
    super('refused')
    this.suggestion = suggestion
  }
}

export function NewSpace() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [name, setName] = useState('')
  const field = useId()
  const slug = normalizeSlug(name)

  const make = useMutation({
    mutationFn: async (displayName: string) => {
      const { data, error } = await api.POST('/spaces', {
        body: { displayName, requestKey: retryKey(`space:${displayName}`) },
      })
      // Only one of the refusals carries a free name; the others are a name that cannot be used.
      if (data === undefined)
        throw new Refused('suggestion' in error ? error.suggestion : undefined)
      retryKeyDone(`space:${displayName}`)
      return data
    },
    onSuccess: async (space) => {
      await client.invalidateQueries({ queryKey: ME })
      await navigate({ to: '/s/$slug', params: { slug: space.slug } })
    },
  })

  const refused = make.error instanceof Refused ? make.error : undefined
  // Anything else is not the server saying no — it is nobody answering at all.
  const broke = make.error !== null && refused === undefined

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault()
        make.mutate(name.trim())
      }}
    >
      <div className="panel-head">
        <h2>New Space</h2>
      </div>

      <div className="stack">
        <div className="stack-tight">
          <label className="label" htmlFor={field}>
            Name
          </label>
          <div className="beside">
            <input
              id={field}
              className="field"
              value={name}
              placeholder="Acme"
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
            <button
              className="button button-primary"
              type="submit"
              disabled={slug === null || make.isPending}
            >
              <span className="button-label">{make.isPending ? 'Making…' : 'Make it'}</span>
            </button>
          </div>
          <p className="preview">
            {name.trim() === '' ? (
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
        </div>

        {refused !== undefined && (
          <p className="said said-bad" role="alert">
            <ExclamationCircleFill aria-hidden />
            {refused.suggestion === undefined
              ? 'That name cannot be used. Try another.'
              : `Somebody holds that address. ${refused.suggestion} is free — for now.`}
          </p>
        )}

        {broke && (
          <p className="said said-bad" role="alert">
            <ExclamationCircleFill aria-hidden />
            That could not be sent. Try again shortly.
          </p>
        )}
      </div>
    </form>
  )
}
