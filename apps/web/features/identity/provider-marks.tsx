/**
 * The marks of the ways in, as pixel art.
 *
 * The artwork is ours, the colours are theirs:
 * Google split into the four brand colours along the same arcs the official G uses — red over
 * the top, blue for the crossbar and the right stroke, green along the bottom, yellow up the
 * lower left — done by rasterising the polygon onto its 24×24 grid and painting each cell by
 * angle from the centre; GitHub's cat in its one brand ink, because the Invertocat
 * has no other colour.
 */

export function GoogleMark({ size = 18 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden>
      <path
        fill="#EA4335"
        d="M9 1h6v1h-6zM7 2h10v1h-10zM5 3h14v1h-14zM4 4h15v1h-15zM3 5h15v1h-15zM3 6h6v1h-6zM15 6h2v1h-2zM4 7h3v1h-3zM6 8h1v1h-1z"
      />
      <path
        fill="#FBBC05"
        d="M2 7h2v1h-2zM2 8h4v1h-4zM1 9h5v1h-5zM1 10h5v1h-5zM1 11h5v1h-5zM1 12h5v1h-5zM1 13h5v1h-5zM1 14h5v1h-5zM2 15h5v1h-5zM2 16h5v1h-5zM3 17h4v1h-4zM3 18h3v1h-3zM4 19h1v1h-1z"
      />
      <path
        fill="#34A853"
        d="M7 17h2v1h-2zM15 17h3v1h-3zM6 18h13v1h-13zM5 19h15v1h-15zM5 20h14v1h-14zM7 21h10v1h-10zM9 22h6v1h-6z"
      />
      <path
        fill="#4285F4"
        d="M12 10h11v1h-11zM12 11h11v1h-11zM12 12h11v1h-11zM12 13h11v1h-11zM18 14h5v1h-5zM17 15h5v1h-5zM17 16h5v1h-5zM18 17h3v1h-3zM19 18h2v1h-2z"
      />
    </svg>
  )
}

export function GitHubMark({ size = 18 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden>
      <polygon
        fill="#181717"
        points="23 9 23 15 22 15 22 17 21 17 21 19 20 19 20 20 19 20 19 21 18 21 18 22 16 22 16 23 15 23 15 18 14 18 14 17 15 17 15 16 17 16 17 15 18 15 18 14 19 14 19 9 18 9 18 6 16 6 16 7 15 7 15 8 14 8 14 7 10 7 10 8 9 8 9 7 8 7 8 6 6 6 6 9 5 9 5 14 6 14 6 15 7 15 7 16 9 16 9 18 7 18 7 17 6 17 6 16 4 16 4 17 5 17 5 19 6 19 6 20 9 20 9 23 8 23 8 22 6 22 6 21 5 21 5 20 4 20 4 19 3 19 3 17 2 17 2 15 1 15 1 9 2 9 2 7 3 7 3 5 4 5 4 4 5 4 5 3 7 3 7 2 9 2 9 1 15 1 15 2 17 2 17 3 19 3 19 4 20 4 20 5 21 5 21 7 22 7 22 9 23 9"
      />
    </svg>
  )
}
