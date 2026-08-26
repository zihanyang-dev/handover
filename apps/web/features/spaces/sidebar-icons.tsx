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
