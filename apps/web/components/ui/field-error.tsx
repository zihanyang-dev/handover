import type { ReactNode } from 'react'

/** A field's changing failure: associated by id and announced only when it has words. */
export function FieldError({
  id,
  shown,
  children,
}: {
  readonly id: string
  readonly shown: boolean
  readonly children: ReactNode
}) {
  return (
    <p
      id={id}
      className="auth-error"
      role={shown ? 'alert' : undefined}
      data-shown={shown ? '' : undefined}
    >
      {shown ? children : null}
    </p>
  )
}
