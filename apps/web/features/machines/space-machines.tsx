/**
 * Every machine this Space can reach, and the three things somebody does about one of their own:
 * name its agents, say how much each takes on at a time, and disconnect it.
 *
 * Handing one to somebody else is an owner's, and it is the thing to do *before* taking that
 * person out — see `member-removal.tsx`.
 */

import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ExclamationTriangle, Laptop } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import type { components } from '../../generated/api.ts'
import { peopleIn } from '../spaces/people.ts'
import { AgentMark, agentKindName } from './agent.tsx'
import {
  machinesIn,
  useAgentSettings,
  useDisconnectMachine,
  useHandMachineTo,
  type Machine,
} from './machine-list.ts'

type Member = components['schemas']['Member']

/**
 * The most this box offers.
 *
 * A mirror of `AT_ONCE_AT_MOST` in `apps/server/src/machine/at-once.ts`, which is the authority
 * along with the column's own constraint. Here so the spinner stops where the server does rather
 * than letting somebody type a number that comes back refused; anything that gets past it is
 * still refused there, and said so below.
 */
const AT_MOST_AT_ONCE = 16

export function SpaceMachines({ slug }: { readonly slug: string }) {
  const machines = useQuery(machinesIn(slug))
  const people = useQuery(peopleIn(slug))
  const own = people.data?.find((person) => person.you)
  const canTransfer = own?.role === 'owner'

  if (machines.isPending || people.isPending) return <PanelState>Looking for machines…</PanelState>
  if (machines.isError || people.isError)
    return <PanelState>Could not read the machines here. Try again.</PanelState>

  return (
    <section aria-labelledby="space-machines-title">
      <header className="mb-8">
        <h1
          id="space-machines-title"
          className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-panel-ink"
        >
          Machines
        </h1>
        <p className="mt-1 text-[14px] leading-5 text-panel-ink-soft">
          See where agents run and manage the machines that belong to you.
        </p>
      </header>
      {machines.data.length === 0 ? (
        <EmptyMachines />
      ) : (
        <ul className="m-0 list-none divide-y divide-panel-line border-y border-panel-line p-0">
          {machines.data.map((machine) => (
            <MachineRow
              key={machine.id}
              slug={slug}
              machine={machine}
              people={people.data}
              canTransfer={canTransfer}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function MachineRow({
  slug,
  machine,
  people,
  canTransfer,
}: {
  readonly slug: string
  readonly machine: Machine
  readonly people: readonly Member[]
  readonly canTransfer: boolean
}) {
  // Anybody here but whoever already has it. By id: two people in one Space can share a display
  // name, and handing a machine to the person who already holds it is a button that does nothing.
  const recipients = people.filter((person) => person.userId !== machine.ownerUserId)

  return (
    <li className="py-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[7px] bg-panel-fill text-panel-ink-muted">
          <Laptop aria-hidden />
        </span>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="truncate text-[14px] font-semibold text-panel-ink">{machine.name}</h2>
            <Presence machine={machine} />
          </div>
          <p className="mt-0.5 text-[12px] leading-[17px] text-panel-ink-quiet">
            {machine.yours ? 'Yours' : machine.ownerName}
            {machine.version === undefined ? '' : ` · handover ${machine.version}`}
          </p>
          {machine.connectedIn !== undefined && (
            <p className="mt-1 truncate font-mono text-[12px] leading-[17px] text-panel-ink-muted">
              {machine.connectedIn}
            </p>
          )}
        </div>
      </div>
      <AgentSettings slug={slug} machine={machine} />
      <div className="mt-4 ml-12 flex flex-wrap items-center gap-2 max-sm:ml-0">
        {canTransfer && recipients.length > 0 && (
          <TransferMachine slug={slug} machine={machine} recipients={recipients} />
        )}
        {machine.yours && <DisconnectMachine machine={machine} slug={slug} />}
      </div>
    </li>
  )
}

function Presence({ machine }: { readonly machine: Machine }) {
  const here = machine.presence.state === 'here'
  return (
    <span
      className={
        here
          ? 'inline-flex items-center gap-1 text-[12px] text-panel-good'
          : 'inline-flex items-center gap-1 text-[12px] text-panel-ink-quiet'
      }
    >
      <span
        className={
          here
            ? 'size-1.5 rounded-full bg-panel-good-mark'
            : 'size-1.5 rounded-full bg-panel-ink-off'
        }
        aria-hidden
      />
      {here ? 'Online' : 'Offline'}
    </span>
  )
}

function AgentSettings({ slug, machine }: { readonly slug: string; readonly machine: Machine }) {
  if (machine.agents.length === 0)
    return (
      <p className="mt-4 rounded-[7px] bg-panel-fill p-3 text-[13px] text-panel-ink-muted">
        No agents found on this machine.
      </p>
    )

  return (
    <ul className="mt-4 ml-12 list-none divide-y divide-panel-line rounded-[7px] border border-panel-line p-0 max-sm:ml-0">
      {machine.agents.map((agent) => (
        <AgentRow key={agent.kind} slug={slug} machine={machine} agent={agent} />
      ))}
    </ul>
  )
}

/**
 * What its owner has decided about one agent: what to call it, and how much it takes on at once.
 *
 * Held in state rather than read off the form when Save is pressed. Read off the form it had two
 * ways of doing nothing at all — a box left empty gave `NaN`, and the elements were fetched by
 * name and checked, and both paths simply returned. A button that neither works nor says why is
 * worse than one that is not there.
 */
function AgentRow({
  slug,
  machine,
  agent,
}: {
  readonly slug: string
  readonly machine: Machine
  readonly agent: Machine['agents'][number]
}) {
  return (
    <li className="p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center text-panel-ink-muted [&_svg]:size-4">
          <AgentMark kind={agent.kind} />
        </span>
        <span className="text-[13px] font-medium text-panel-ink-body">
          {agentKindName(agent.kind)}
        </span>
        <span className="text-[12px] text-panel-ink-quiet">{agent.version}</span>
      </div>
      {machine.yours && <AgentDecisions slug={slug} machineId={machine.id} agent={agent} />}
    </li>
  )
}

function AgentDecisions({
  slug,
  machineId,
  agent,
}: {
  readonly slug: string
  readonly machineId: string
  readonly agent: Machine['agents'][number]
}) {
  const decide = useAgentSettings(slug)
  // Empty means nobody has named it, which is what null on the wire says and the only way to take
  // a name off. The placeholder shows what it is called while nobody has.
  const [name, setName] = useState(agent.name ?? '')
  const [atOnce, setAtOnce] = useState(String(agent.atOnce))
  const wanted = Number(atOnce)
  const isUsable = Number.isInteger(wanted) && wanted >= 1 && wanted <= AT_MOST_AT_ONCE

  return (
    <>
      <form
        className="mt-3 flex items-end gap-2 max-sm:flex-col max-sm:items-stretch"
        onSubmit={(event) => {
          event.preventDefault()
          decide.mutate({
            params: { path: { id: machineId, kind: agent.kind } },
            body: { name: name.trim() === '' ? null : name.trim(), atOnce: wanted },
          })
        }}
      >
        <label className="min-w-0 grow text-[12px] font-medium text-panel-ink-muted">
          Name
          <input
            className="mt-1 block h-8 w-full rounded-[5px] border border-panel-line-firm bg-white px-2 text-[13px] font-normal text-panel-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            value={name}
            maxLength={48}
            placeholder={agentKindName(agent.kind)}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>
        <label className="w-[92px] shrink-0 text-[12px] font-medium text-panel-ink-muted">
          At once
          <input
            className="mt-1 block h-8 w-full rounded-[5px] border border-panel-line-firm bg-white px-2 text-[13px] font-normal text-panel-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            type="number"
            min={1}
            max={AT_MOST_AT_ONCE}
            value={atOnce}
            aria-invalid={!isUsable}
            onChange={(event) => {
              setAtOnce(event.target.value)
            }}
          />
        </label>
        <button
          className="h-8 shrink-0 rounded-[5px] border border-panel-line-firm px-3 text-[13px] font-medium text-panel-ink-body hover:bg-panel-fill disabled:opacity-45"
          type="submit"
          disabled={!isUsable || decide.isPending}
        >
          Save
        </button>
      </form>
      {!isUsable && (
        <p className="mt-2 text-[12px] text-panel-danger" role="alert">
          At once is a whole number between 1 and {AT_MOST_AT_ONCE}.
        </p>
      )}
      {decide.isError && (
        <p className="mt-2 text-[12px] text-panel-danger" role="alert">
          That could not be sent. Try again.
        </p>
      )}
    </>
  )
}

function TransferMachine({
  slug,
  machine,
  recipients,
}: {
  readonly slug: string
  readonly machine: Machine
  readonly recipients: readonly Member[]
}) {
  const transfer = useHandMachineTo(slug)
  const [ownerUserId, setOwnerUserId] = useState(recipients[0]?.userId ?? '')

  return (
    <>
      <select
        className="h-8 max-w-[220px] rounded-[5px] border border-panel-line-firm bg-white px-2 text-[13px] text-panel-ink-soft"
        aria-label={`New owner for ${machine.name}`}
        value={ownerUserId}
        onChange={(event) => {
          setOwnerUserId(event.target.value)
        }}
      >
        {recipients.map((person) => (
          <option key={person.userId} value={person.userId}>
            {person.displayName}
          </option>
        ))}
      </select>
      <button
        className="h-8 rounded-[5px] border border-panel-line-firm px-2 text-[13px] font-medium text-panel-ink-body hover:bg-panel-fill disabled:opacity-45"
        type="button"
        disabled={ownerUserId === '' || transfer.isPending}
        onClick={() => {
          transfer.mutate({
            params: { path: { slug, id: machine.id } },
            body: { ownerUserId },
          })
        }}
      >
        Transfer
      </button>
      {transfer.isError && (
        <p className="w-full text-[12px] text-panel-danger" role="alert">
          {whyItStayed(transfer.error)}
        </p>
      )}
    </>
  )
}

/** Named reasons come from `member-api.ts` and `machine-api.ts`; anything else never arrived. */
function whyItStayed(thrown: unknown): string {
  const reason = reasonOf(thrown)
  if (reason === 'not-an-owner') return 'Only an owner can hand a machine to somebody else.'
  if (reason === 'not-a-member') return 'That person is not in this Space any more.'

  return 'That could not be sent. Try again.'
}

function DisconnectMachine({
  machine,
  slug,
}: {
  readonly machine: Machine
  readonly slug: string
}) {
  const disconnect = useDisconnectMachine(slug)
  const [confirming, setConfirming] = useState(false)

  if (!confirming)
    return (
      <button
        className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-panel-danger-quiet hover:bg-panel-danger-wash"
        type="button"
        onClick={() => {
          setConfirming(true)
        }}
      >
        Disconnect
      </button>
    )

  return (
    <DisconnectConfirmation
      machine={machine}
      pending={disconnect.isPending}
      cancel={() => {
        setConfirming(false)
      }}
      confirm={() => {
        disconnect.mutate({ params: { path: { id: machine.id } } })
      }}
    />
  )
}

function DisconnectConfirmation({
  machine,
  pending,
  cancel,
  confirm,
}: {
  readonly machine: Machine
  readonly pending: boolean
  readonly cancel: () => void
  readonly confirm: () => void
}) {
  return (
    <div className="w-full rounded-[7px] border border-panel-danger-line bg-panel-danger-notice p-3">
      <p className="flex items-start gap-2 text-[13px] leading-[18px] text-panel-danger-ink">
        <ExclamationTriangle className="mt-0.5 shrink-0" aria-hidden />
        Disconnecting {machine.name} revokes its credential. Agents on it become unreachable until
        it is connected again.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="h-8 rounded-[5px] border-0 bg-transparent px-3 text-[13px] font-medium hover:bg-white"
          type="button"
          onClick={cancel}
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-[5px] border-0 bg-panel-danger-fill px-3 text-[13px] font-medium text-white disabled:opacity-45"
          type="button"
          disabled={pending}
          onClick={confirm}
        >
          Disconnect machine
        </button>
      </div>
    </div>
  )
}

function EmptyMachines() {
  return (
    <div className="rounded-[8px] border border-dashed border-panel-line-firm px-6 py-12 text-center">
      <Laptop className="mx-auto mb-3 text-panel-ink-quiet" aria-hidden />
      <p className="text-[14px] font-medium text-panel-ink-body">No machines here</p>
      <p className="mt-1 text-[13px] text-panel-ink-quiet">
        Run handover connect on the machine where an agent should work.
      </p>
    </div>
  )
}

function PanelState({ children }: { readonly children: ReactNode }) {
  return (
    <p className="py-10 text-center text-[14px] text-panel-ink-muted" role="status">
      {children}
    </p>
  )
}
