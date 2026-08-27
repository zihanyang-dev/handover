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
import { useNavigate } from '@tanstack/react-router'
import { api } from '../../api.ts'
import { agentName, type AgentKind } from '../agents.ts'
import { useMachineKey, type Keyed } from './machine-key.tsx'
import { useOpenConversation } from '../conversations/talking.ts'
import { ShellCommand } from '../shell-command.tsx'

function machinesIn(slug: string) {
  return {
    queryKey: ['machines', slug] as const,
    // Somebody is looking at this page *because* they are connecting a machine on another one,
    // and the terminal over there takes as long as it takes. Asking again is how the machine
    // turns up by itself rather than after somebody thinks to refresh.
    refetchInterval: 3000,
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
      const { response } = await api.DELETE('/me/machines/{id}', { params: { path: { id } } })
      // A row that stays put with no explanation is a button that did nothing.
      if (!response.ok) throw new Error('still-here')
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

      {/* Where connecting a machine happens, for every Space and not only a brand new one. What
          decides whether to say this is whether anything can run here — which is true of a Space
          made a minute ago and of one whose only machine was just disconnected. */}
      {machines.isSuccess && attached.length === 0 && <NothingHere />}

      <ul className="rows">
        {attached.map((machine) => (
          <li key={machine.id} className="row">
            <span className="row-name">
              <Laptop aria-hidden />
              <strong>{machine.name}</strong>
              {/* Whose it is, on every row that is not yours. A Space with two people in it has
                  two people's laptops in it, and what an agent does on one of them happens in
                  that person's files — which a name on its own does not say. */}
              {!machine.yours && <span className="note">{machine.ownerName}&rsquo;s</span>}
              {machine.presence.state === 'here' ? (
                <span className="chip chip-ready">Online</span>
              ) : (
                <span className="note">
                  Offline · last seen {minutesSince(machine.presence.since)} minutes ago
                </span>
              )}
              {/*
                Which build is on that machine — the one question about it that cannot be answered
                from the machine itself, because the person asking is not sitting at it. Said as
                unknown rather than left blank: a machine too old to report its version is exactly
                the machine somebody is trying to work out what is wrong with.
              */}
              <span className="note">
                {machine.version === undefined
                  ? 'handover · unknown version'
                  : `handover ${machine.version}`}
              </span>
              {/*
                Said even when there are none. A connected machine with no agents is a machine
                with something to install, and calling it "no machines" would send somebody to
                connect one that is already connected.
              */}
              {machine.agents.length === 0 ? (
                <span className="note">No agents found on it yet</span>
              ) : (
                machine.agents.map((agent) => (
                  <TalkTo
                    key={agent.kind}
                    slug={slug}
                    machineId={machine.id}
                    kind={agent.kind}
                    version={agent.version}
                    here={machine.presence.state === 'here'}
                  />
                ))
              )}
            </span>
            {/* Only on your own. A machine belongs to whoever connected it, so a button here on
                somebody else's would be a button that always fails — and offering one is worse
                than not having one, because it reads as something you may do. */}
            {machine.yours && (
              <button
                className="button button-quiet"
                type="button"
                disabled={detach.isPending}
                onClick={() => {
                  detach.mutate(machine.id)
                }}
              >
                <span className="button-label">
                  {detach.isError ? 'Could not disconnect it' : 'Disconnect'}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>

      <MachineKey />
    </section>
  )
}

/**
 * One agent on one machine, as a way in.
 *
 * The way to start talking to an agent is to point at the one you mean, where it is. A second
 * list somewhere else asking which machine and which agent would be the same question asked
 * again, about the same rows already on this screen.
 */
function TalkTo({
  slug,
  machineId,
  kind,
  version,
  here,
}: {
  readonly slug: string
  readonly machineId: string
  readonly kind: AgentKind
  readonly version: string
  readonly here: boolean
}) {
  const navigate = useNavigate()
  const open = useOpenConversation(slug)

  return (
    <button
      className="button button-quiet"
      type="button"
      // Nothing would pick it up, so it is refused before it is started rather than after.
      disabled={!here || open.isPending}
      title={here ? undefined : 'This machine is not here'}
      onClick={() => {
        open.mutate(
          { machineId, agentKind: kind },
          {
            onSuccess: (id) => {
              void navigate({ to: '/s/$slug/c/$id', params: { slug, id } })
            },
          },
        )
      }}
    >
      <span className="button-label">
        {agentName(kind)} {version}
      </span>
    </button>
  )
}

/**
 * A Space with nothing that can run in it, which is where connecting a machine happens.
 *
 * Every Space, not only a brand new one: what decides whether to say this is whether anything can
 * run here, which is as true of a Space whose only machine was just disconnected. Said in the one
 * place that knows, so nobody is walked through connecting a machine they already have.
 */
function NothingHere() {
  return (
    <div className="stack-tight">
      <p className="empty">
        Nothing can run here yet. Agents run on <strong>your</strong> machine, not on ours — run
        this on the one you want to use.
      </p>
      <ShellCommand command="handover connect" />
      {/* Nobody has to come back and look: the list above keeps asking, so a machine that
          finishes connecting appears where this message was. */}
      <p className="note">This page is watching. It will appear here.</p>
    </div>
  )
}

/**
 * A key for a machine with no browser to open, asked for from here.
 *
 * The same key onboarding hands out, from the same place — see `machine-key.ts`. What differs is
 * only when somebody is offered it: there, on the way in; here, when a Space already has machines
 * and one more has no browser on it.
 */
function MachineKey() {
  const [asked, setAsked] = useState(false)
  const key = useMachineKey(asked)

  if (asked && key.state === 'ready') {
    return (
      <div className="stack-tight" style={{ marginTop: '0.75rem' }}>
        <p className="label">Run this on that machine, within {minutes(key.secondsLeft)}</p>
        <ShellCommand command={key.command} />
        {/*
          Said because it is true and cannot be undone: only the hash is kept, so this is the one
          moment it can be read. Somebody who closes this without copying it needs another key,
          not a way to look this one up.
        */}
        <p className="note">Shown once. Close this and you will need a new one.</p>
      </div>
    )
  }

  // Expired reads differently from never made: one is a command that has stopped working, and
  // leaving it on screen invites somebody to run it and be turned away with no explanation.
  const gone = asked && (key.state === 'expired' || key.state === 'unavailable')

  return (
    <>
      {asked && key.state === 'expired' && (
        <p className="note" style={{ marginTop: '0.75rem' }}>
          That key can no longer connect a machine.
        </p>
      )}
      <button
        className="button button-quiet"
        type="button"
        style={{ marginTop: '0.75rem' }}
        disabled={asked && key.state === 'making'}
        onClick={() => {
          if (gone) key.again()
          setAsked(true)
        }}
      >
        <span className="button-label">{wording(asked ? key.state : 'idle')}</span>
      </button>
    </>
  )
}

/** What the button says, which is a different sentence for each way it can be pressed. */
function wording(state: Keyed['state'] | 'idle'): string {
  if (state === 'expired') return 'Make another key'
  if (state === 'unavailable') return 'Could not make a key. Try again.'

  return 'Add a machine with no browser'
}

/** How long is left, in the words a person reads on a command they are about to run. */
function minutes(seconds: number): string {
  const left = Math.max(1, Math.ceil(seconds / 60))

  return left === 1 ? '1 minute' : `${String(left)} minutes`
}
