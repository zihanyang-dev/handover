/**
 * The machines in this Space.
 *
 * An empty Space says what to do about it rather than saying nothing: agents run on somebody's own
 * machine, and until one is here there is nothing this Space can do. That is worth saying before
 * they wonder why.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'
import { Laptop } from 'react-bootstrap-icons'
import { api } from '../../api.ts'

const LOOKS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'cursor-agent': 'Cursor Agent',
}

function machinesIn(slug: string) {
  return {
    queryKey: ['machines', slug] as const,
    queryFn: async () => {
      const { data, error } = await api.GET('/spaces/{slug}/machines', {
        params: { path: { slug } },
      })
      if (data === undefined) throw new Error(error.reason)
      return data.machines
    },
  }
}

/** Rounded up, so "1 minute ago" never means "any moment now". */
function minutesSince(since: string): number {
  return Math.max(Math.ceil((Date.now() - new Date(since).getTime()) / 60_000), 1)
}

export function Machines({ slug }: { readonly slug: string }) {
  const heading = useId()
  const machines = useQuery(machinesIn(slug))
  const client = useQueryClient()

  const detach = useMutation({
    mutationFn: async (id: string) => {
      await api.DELETE('/spaces/{slug}/machines/{id}', { params: { path: { slug, id } } })
    },
    onSuccess: async () => client.invalidateQueries({ queryKey: ['machines', slug] }),
  })

  const attached = machines.data ?? []

  return (
    // Named, so it is a region somebody can jump to rather than a run of unlabelled rows.
    <section className="panel" aria-labelledby={heading}>
      <div className="panel-head">
        <h2 id={heading}>Machines</h2>
      </div>

      {/*
        Three different things, kept apart. Folding a failed read into "none" would tell somebody
        to go and connect a machine they may already have connected, and the terminal on it would
        be saying it is online the whole time.
      */}
      {machines.isError && <p className="empty">Could not read the machines here. Try again.</p>}

      {machines.isPending && <p className="empty">Looking…</p>}

      {machines.isSuccess && attached.length === 0 && (
        <p className="empty">
          Nothing can run here yet. Agents run on <strong>your</strong> machine, not on ours — run{' '}
          <code>handover connect</code> on the one you want to use.
        </p>
      )}

      <ul className="rows">
        {attached.map((machine) => (
          <li key={machine.id} className="row">
            <span className="row-name">
              <Laptop aria-hidden />
              <strong>{machine.name}</strong>
              {machine.presence.state === 'here' ? (
                <span className="chip chip-ready">Online</span>
              ) : (
                <span className="note">
                  Offline · last seen {minutesSince(machine.presence.since)} minutes ago
                </span>
              )}
              {/*
                Said even when there are none. A connected machine with no agents is a machine
                with something to install, and calling it "no machines" would send somebody to
                connect one that is already connected.
              */}
              <span className="note">
                {machine.agents.length === 0
                  ? 'No agents found on it yet'
                  : machine.agents
                      .map((agent) => `${LOOKS[agent.kind] ?? agent.kind} ${agent.version}`)
                      .join(' · ')}
              </span>
            </span>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => {
                detach.mutate(machine.id)
              }}
            >
              <span className="button-label">Remove</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
