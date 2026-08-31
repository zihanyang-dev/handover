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
  const error = useId()

  /**
   * Null until somebody types, so the field follows the server without an effect pushing it
   * there. Cleared again on save, and the field goes back to following what was saved.
   */
  const [typed, setTyped] = useState<string | null>(null)
  const saved = me.data?.displayName ?? ''
  const name = typed ?? saved

  const rename = useMutation({
    mutationFn: async (displayName: string) => {
      const { error, response } = await api.PATCH('/me', { body: { displayName } })
      // Not renamed. Clearing the box and showing the old name would be this page telling somebody
      // their change went through, and they would find out much later that it did not.
      if (!response.ok) throw error
    },
    onSuccess: async () => {
      setTyped(null)
      await client.invalidateQueries({ queryKey: ME })
    },
  })

  const changed = name.trim() !== saved && name.trim() !== ''
  const save = () => {
    if (changed && !rename.isPending) rename.mutate(name.trim())
  }

  return (
    <section className="mb-19.75" aria-labelledby={`${field}-heading`}>
      <h2
        id={`${field}-heading`}
        className="m-0 mb-4 border-b border-line pb-3 text-copy-s leading-6 font-medium text-ink"
      >
        Profile
      </h2>
      <form
        className="flex min-h-15 items-center gap-5.5"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        {me.data === undefined ? (
          <span className="size-15 shrink-0 rounded-full bg-fill" aria-hidden />
        ) : (
          <img
            className="size-15 shrink-0 rounded-full object-cover"
            src={me.data.avatarUrl}
            alt=""
          />
        )}
        <div className="w-full max-w-[320px]">
          <label
            className="mb-1 block text-copy-xxs leading-4 font-normal text-ink-muted"
            htmlFor={field}
          >
            Preferred name
          </label>
          <input
            id={field}
            className="h-8 w-full rounded-[5px] border border-line-firm bg-white px-3 text-copy-xs leading-5 text-ink outline-none transition-colors focus:border-focus focus:ring-1 focus:ring-focus"
            value={name}
            aria-invalid={rename.isError}
            aria-describedby={rename.isError ? error : undefined}
            onBlur={save}
            onChange={(event) => {
              setTyped(event.target.value)
            }}
          />
          {rename.isPending && (
            <p className="m-0 mt-1 text-copy-xxs leading-4 text-ink-muted" role="status">
              Saving…
            </p>
          )}
          {rename.isError && (
            <p
              id={error}
              className="m-0 mt-1 text-copy-xxs leading-4 text-danger-strong"
              role="alert"
            >
              That name could not be saved. Try again.
            </p>
          )}
        </div>
      </form>
    </section>
  )
}
