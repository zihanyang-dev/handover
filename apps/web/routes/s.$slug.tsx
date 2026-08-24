import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { api } from '../api.ts'

function Screen() {
  const { slug } = Route.useParams()
  const space = useQuery({
    queryKey: ['space', slug],
    queryFn: async () => {
      const { data } = await api.GET('/spaces/{slug}', { params: { path: { slug } } })
      return data ?? null
    },
  })

  // Not there and not yours are the same answer, so this page cannot tell them apart either.
  if (space.data === null) {
    return (
      <div className="page">
        <section className="panel">
          <h2>This Space is not available</h2>
          <p className="note" style={{ marginTop: '0.5rem' }}>
            <Link to="/">Back to your Spaces</Link>
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="row">
        <span className="row-name">
          <strong>{space.data?.displayName ?? ''}</strong>
        </span>
        <Link className="row-where" to="/">
          All Spaces
        </Link>
      </div>
      <section className="panel">
        <p className="empty">Nothing lives in a Space yet.</p>
      </section>
    </div>
  )
}

export const Route = createFileRoute('/s/$slug')({ component: Screen })
