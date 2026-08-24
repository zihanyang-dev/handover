/**
 * The name everything shows.
 *
 * It sits here because this is the first screen where a name becomes visible to anybody else.
 * A settings page nobody visits is the same as no way to change it at all.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { api } from '../../api.ts'
import { ME, meQuery } from './me.ts'

export function DisplayName() {
  const me = useQuery(meQuery)
  const client = useQueryClient()
  const field = useId()

  /**
   * Null until somebody types, so the field follows the server without an effect pushing it
   * there. Cleared again on save, and the field goes back to following what was saved.
   */
  const [typed, setTyped] = useState<string | null>(null)
  const saved = me.data?.displayName ?? ''
  const name = typed ?? saved

  const rename = useMutation({
    mutationFn: async (displayName: string) => {
      await api.PATCH('/me', { body: { displayName } })
    },
    onSuccess: async () => {
      setTyped(null)
      await client.invalidateQueries({ queryKey: ME })
    },
  })

  const changed = name.trim() !== saved && name.trim() !== ''

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault()
        rename.mutate(name.trim())
      }}
    >
      <div className="panel-head">
        <h2>Your name</h2>
      </div>

      <div className="stack-tight">
        <label className="label" htmlFor={field}>
          Shown wherever you appear
        </label>
        <div className="beside">
          <input
            id={field}
            className="field"
            value={name}
            onChange={(event) => {
              setTyped(event.target.value)
            }}
          />
          <button
            className="button button-secondary"
            type="submit"
            disabled={!changed || rename.isPending}
          >
            <span className="button-label">{rename.isPending ? 'Saving…' : 'Save'}</span>
          </button>
        </div>
      </div>
    </form>
  )
}
