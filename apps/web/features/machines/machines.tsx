/**
 * The machines in this Space.
 *
 * An empty Space says what to do about it rather than saying nothing: agents run on somebody's own
 * machine, and until one is here there is nothing this Space can do. That is worth saying before
 * they wonder why.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
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

      <MachineKey slug={slug} />
    </section>
  )
}

/**
 * A key for a machine with no browser to open.
 *
 * Generating one here *is* the approving: somebody standing in this Space made the decision that
 * the code path asks a person to make later. Nothing about the mechanism differs after that.
 */
function MachineKey({ slug }: { readonly slug: string }) {
  const [key, setKey] = useState<string>()

  const make = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/spaces/{slug}/machine-keys', {
        params: { path: { slug } },
      })
      if (data === undefined) throw new Error(error.reason)
      return data.key
    },
    onSuccess: setKey,
  })

  if (key !== undefined) {
    return (
      <div className="stack-tight" style={{ marginTop: '0.75rem' }}>
        <p className="label">Run this on that machine, within 15 minutes</p>
        <code className="field">handover connect --key {key}</code>
        {/*
          Said because it is true and cannot be undone: only the hash is kept, so this is the one
          moment it can be read. Somebody who closes this without copying it needs another key,
          not a way to look this one up.
        */}
        <p className="note">Shown once. Close this and you will need a new one.</p>
      </div>
    )
  }

  return (
    <button
      className="button button-quiet"
      type="button"
      style={{ marginTop: '0.75rem' }}
      disabled={make.isPending}
      onClick={() => {
        make.mutate()
      }}
    >
      <span className="button-label">
        {make.isError ? 'Could not make a key. Try again.' : 'Add a machine with no browser'}
      </span>
    </button>
  )
}
