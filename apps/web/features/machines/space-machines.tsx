/**
 * Every machine this Space can reach, and the three things somebody does about one of their own:
 * name its agents, say how much each takes on at a time, and disconnect it.
 *
 * Handing one to somebody else is an owner's, and it is the thing to do *before* taking that
 * person out — see `member-removal.tsx`.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import { ExclamationTriangle, Laptop, ThreeDots } from 'react-bootstrap-icons'
import { reasonOf } from '../../api.ts'
import { MenuSelect } from '../../components/ui/menu-select.tsx'
import { SettingsHeading } from '../../components/ui/settings-heading.tsx'
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

  if (machines.isPending || people.isPending)
    return (
      <p className="py-10 text-center text-[14px] text-panel-ink-muted" role="status">
        Looking for machines…
      </p>
    )
  if (machines.isError || people.isError)
    return (
      <p className="py-10 text-center text-[14px] text-panel-ink-muted" role="alert">
        Could not read the machines here. Try again.
      </p>
    )

  return (
    <section aria-labelledby="space-machines-title">
      <SettingsHeading
        id="space-machines-title"
        title="Machines"
        action={
          <Link
            className="inline-flex h-8 shrink-0 items-center rounded-[6px] bg-primary px-3 text-[13px] font-medium text-white no-underline hover:bg-primary-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            to="/connect"
          >
            Connect machine
          </Link>
        }
      />
      {machines.data.length === 0 ? (
        <EmptyMachines />
      ) : (
        <ul className="m-0 list-none space-y-8 p-0">
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
    <li className="relative py-3">
      <div className="flex items-start gap-3 pr-10">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[7px] bg-panel-fill text-panel-ink-muted">
          <Laptop aria-hidden />
        </span>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="truncate text-[14px] font-semibold text-panel-ink">{machine.name}</h2>
            <Presence machine={machine} />
          </div>
        </div>
      </div>
      <AgentSettings slug={slug} machine={machine} />
      {machine.yours && <DisconnectMachine machine={machine} slug={slug} />}
      {canTransfer && recipients.length > 0 && (
        <div className="mt-4 ml-12 flex flex-wrap items-center gap-2 max-sm:ml-0">
          <TransferMachine slug={slug} machine={machine} recipients={recipients} />
        </div>
      )}
    </li>
  )
}

function Presence({ machine }: { readonly machine: Machine }) {
  const here = machine.presence.state === 'here'
  return (
    <span
      className={
        here
          ? 'inline-flex items-center gap-1.5 text-[12px] text-panel-good'
          : 'inline-flex items-center gap-1.5 text-[12px] text-panel-ink-quiet'
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
    <ul className="mt-4 ml-12 max-w-[440px] list-none space-y-5 p-0 max-sm:ml-0">
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
    <li>
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
  // Null means the person has not edited this field, so polling can keep the visible value current.
  // Once they type, their draft wins until it is saved or the component is left.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [atOnceDraft, setAtOnceDraft] = useState<string | null>(null)
  const atOnceError = useId()
  const name = nameDraft ?? agent.name ?? ''
  const atOnce = atOnceDraft ?? String(agent.atOnce)
  const wanted = Number(atOnce)
  const isUsable = usableAtOnce(wanted)
  const nextName = name.trim() === '' ? null : name.trim()
  const changed = nextName !== agent.name || wanted !== agent.atOnce
  const save = (): void => {
    if (!changed || !isUsable) return
    decide.mutate(
      {
        params: { path: { id: machineId, kind: agent.kind } },
        body: { name: nextName, atOnce: wanted },
      },
      {
        onSuccess: () => {
          setNameDraft(null)
          setAtOnceDraft(null)
        },
      },
    )
  }

  return (
    <>
      <form
        className="mt-2 ml-7 grid gap-1 max-sm:ml-0"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <label className="grid min-h-9 grid-cols-[64px_minmax(0,1fr)] items-center gap-3 text-[12px] font-medium text-panel-ink-muted">
          <span>Name</span>
          <input
            className="h-8 w-full max-w-[280px] rounded-[5px] border border-panel-line-firm bg-white px-2 text-[13px] font-normal text-panel-ink outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary"
            value={name}
            maxLength={48}
            placeholder={agentKindName(agent.kind)}
            onBlur={save}
            onChange={(event) => {
              setNameDraft(event.target.value)
            }}
          />
        </label>
        <label className="grid min-h-9 grid-cols-[64px_minmax(0,1fr)] items-center gap-3 text-[12px] font-medium text-panel-ink-muted">
          <span>At once</span>
          <input
            className="h-8 w-[72px] rounded-[5px] border border-panel-line-firm bg-white px-2 text-[13px] font-normal text-panel-ink outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary"
            type="number"
            min={1}
            max={AT_MOST_AT_ONCE}
            value={atOnce}
            aria-invalid={!isUsable}
            aria-describedby={isUsable ? undefined : atOnceError}
            onBlur={save}
            onChange={(event) => {
              setAtOnceDraft(event.target.value)
            }}
          />
        </label>
      </form>
      {!isUsable && (
        <p id={atOnceError} className="mt-2 text-[12px] text-panel-danger" role="alert">
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

function usableAtOnce(wanted: number): boolean {
  return Number.isInteger(wanted) && wanted >= 1 && wanted <= AT_MOST_AT_ONCE
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
      <div className="w-full max-w-[220px]">
        <MenuSelect
          label={`New owner for ${machine.name}`}
          value={ownerUserId}
          choices={recipients.map((person) => ({
            value: person.userId,
            label: person.displayName,
          }))}
          onChange={setOwnerUserId}
          stretch
        />
      </div>
      <button
        className="h-8 rounded-[6px] border-0 bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-200 disabled:cursor-not-allowed disabled:opacity-45"
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
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
    }
  }, [open])

  if (!confirming)
    return (
      <div ref={root} className="absolute top-3 right-0">
        <button
          ref={trigger}
          className="flex size-7 items-center justify-center rounded-[5px] border-0 bg-transparent text-panel-ink-quiet hover:bg-[var(--interaction-hover)] hover:text-panel-ink"
          type="button"
          aria-label={`${machine.name} actions`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setOpen((shown) => !shown)
          }}
        >
          <ThreeDots aria-hidden />
        </button>
        {open && (
          <div
            className="absolute top-full right-0 z-20 mt-1 w-44 rounded-[7px] bg-white p-1 shadow-[var(--surface-raised-shadow)]"
            role="menu"
            aria-label={`${machine.name} actions`}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
              trigger.current?.focus()
            }}
          >
            <button
              className="flex h-8 w-full items-center rounded-[5px] border-0 bg-transparent px-2 text-left text-[13px] text-panel-danger-quiet hover:bg-panel-danger-wash focus:bg-panel-danger-wash focus:outline-none"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setConfirming(true)
              }}
            >
              Disconnect machine
            </button>
          </div>
        )}
      </div>
    )

  return (
    <div className="mt-4 ml-12 max-sm:ml-0">
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
    </div>
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
