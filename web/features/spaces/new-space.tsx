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
import { normalizeSlug } from '../../../src/space/slug.ts'
import { api, retryKey, retryKeyDone } from '../../api.ts'
import { ME } from '../identity/me.ts'

type Refused = { readonly reason: string; readonly suggestion?: string }

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
      if (data === undefined) throw new Error(JSON.stringify(error))
      retryKeyDone(`space:${displayName}`)
      return data
    },
    onSuccess: async (space) => {
      await client.invalidateQueries({ queryKey: ME })
      await navigate({ to: '/s/$slug', params: { slug: space.slug } })
    },
  })

  const refused = make.error === null ? undefined : (JSON.parse(make.error.message) as Refused)

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
          <p className="said said-bad">
            <ExclamationCircleFill aria-hidden />
            {refused.suggestion === undefined
              ? 'That name cannot be used. Try another.'
              : `Somebody holds that address. ${refused.suggestion} is free — for now.`}
          </p>
        )}
      </div>
    </form>
  )
}
