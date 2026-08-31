import type { ReactNode } from 'react'

/** The one heading rhythm shared by every top-level Settings panel. */
export function SettingsHeading({
  id,
  title,
  action,
}: {
  readonly id: string
  readonly title: string
  readonly action?: ReactNode
}) {
  return (
    <header className="mb-9 flex items-center justify-between gap-4">
      <h1 id={id} className="m-0 text-[26px] leading-8 font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      {action}
    </header>
  )
}
