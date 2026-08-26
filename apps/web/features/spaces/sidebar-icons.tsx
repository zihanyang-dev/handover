/**
 * The sidebar glyphs, traced from Notion's live 20×20 SVGs rather than approximated with a
 * different icon family. They inherit the surrounding ink exactly as Notion's do.
 */

type IconProps = { readonly className?: string | undefined }

export function HomeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <path d="M9.08 3.341a1.625 1.625 0 0 1 1.84 0l5.875 4.035c.441.304.705.805.705 1.34v6.034a2.125 2.125 0 0 1-2.125 2.125h-2.716a1.625 1.625 0 0 1-1.625-1.625v-4.065H8.967v4.065c0 .898-.728 1.625-1.625 1.625H4.625A2.125 2.125 0 0 1 2.5 14.75V8.716c0-.535.264-1.036.705-1.34zm1.132 1.03a.375.375 0 0 0-.424 0L3.913 8.407a.38.38 0 0 0-.163.309v6.034c0 .483.392.875.875.875h2.716a.375.375 0 0 0 .375-.375v-4.19c0-.621.503-1.125 1.125-1.125h2.319c.62 0 1.124.504 1.124 1.125v4.19c0 .207.168.375.375.375h2.716a.875.875 0 0 0 .875-.875V8.716c0-.124-.06-.24-.163-.31z" />
    </svg>
  )
}

export function CollapseIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <path d="M3.608 10.442a.625.625 0 0 1 0-.884l5.4-5.4a.625.625 0 0 1 .884.884L4.934 10l4.958 4.958a.625.625 0 1 1-.884.884z" />
      <path d="m14.508 4.158-5.4 5.4a.625.625 0 0 0 0 .884l5.4 5.4a.625.625 0 1 0 .884-.884L10.434 10l4.958-4.958a.625.625 0 1 0-.884-.884" />
    </svg>
  )
}

export function MenuIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <path d="M2.275 5c0-.345.28-.625.625-.625h14.2a.625.625 0 1 1 0 1.25H2.9A.625.625 0 0 1 2.275 5m0 5c0-.345.28-.625.625-.625h14.2a.625.625 0 1 1 0 1.25H2.9A.625.625 0 0 1 2.275 10m.625 4.375a.625.625 0 1 0 0 1.25h14.2a.625.625 0 1 0 0-1.25z" />
    </svg>
  )
}

/** The account. Traced the same way as the others, so it sits at the same weight beside them. */
export function PersonIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <path d="M10 3.25a3.375 3.375 0 1 0 0 6.75 3.375 3.375 0 0 0 0-6.75M7.875 6.625a2.125 2.125 0 1 1 4.25 0 2.125 2.125 0 0 1-4.25 0M10 11.25c-1.72 0-3.166.4-4.19 1.05-1.017.646-1.685 1.596-1.685 2.7 0 .621.504 1.125 1.125 1.125h9.5c.621 0 1.125-.504 1.125-1.125 0-1.104-.668-2.054-1.686-2.7-1.023-.65-2.469-1.05-4.189-1.05m-4.62 3.625c.043-.57.39-1.13 1.101-1.582.79-.502 1.99-.856 3.519-.856s2.728.354 3.518.856c.712.452 1.059 1.011 1.102 1.582z" />
    </svg>
  )
}
