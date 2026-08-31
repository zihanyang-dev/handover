/**
 * The same physical machines in two honest projections.
 *
 * Account shows only machines this person controls and owns their global decisions. A Space shows
 * every machine explicitly available there and owns only adding or removing that relationship.
 */

import { AT_ONCE_AT_MOST } from '@handover/universal'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { Laptop } from 'react-bootstrap-icons'
import { SettingsHeading } from '../../components/ui/settings-heading.tsx'
import { peopleIn } from '../spaces/people.ts'
import { AgentMark, agentKindName } from './agent.tsx'
import {
  machinesIn,
  ownedMachines,
  useAddMachineToSpace,
  useAgentSettings,
  useDisconnectMachine,
  useRemoveMachineFromSpace,
  type Machine,
  type OwnedMachine,
} from './machine-list.ts'

type ShownMachine = Machine | OwnedMachine

const primaryAction =
  'inline-flex h-8 shrink-0 items-center rounded-[6px] border-0 bg-primary px-3 text-[13px] font-medium text-white no-underline hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
const quietDanger =
  'mt-3 ml-12 h-7 rounded-[5px] border-0 bg-transparent px-2 text-[12px] text-danger-quiet hover:bg-danger-wash max-sm:ml-0'
const dangerAction =
  'h-8 rounded-[6px] border-0 bg-danger-strong px-3 text-[13px] font-medium text-white disabled:opacity-50'
const secondaryAction =
  'h-8 rounded-[6px] border border-line-firm bg-white px-3 text-[13px] text-ink-body'

export function YourMachines() {
  const machines = useQuery(ownedMachines())

  return (
    <section className="mt-12 border-t border-line pt-8" aria-labelledby="your-machines-title">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 id="your-machines-title" className="m-0 text-[16px] font-semibold text-ink">
            Your machines
          </h2>
          <p className="mt-1 text-[13px] text-ink-quiet">
            Computers you have connected to Handover.
          </p>
        </div>
        <Link className={primaryAction} to="/connect" search={{}}>
          Connect machine
        </Link>
      </div>
      <QueryState
        pending={machines.isPending}
        failed={machines.isError}
        count={machines.data?.length}
        empty="You have not connected a machine yet."
      />
      {machines.data !== undefined && machines.data.length > 0 && (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {machines.data.map((machine) => (
            <AccountMachineRow key={machine.id} machine={machine} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function SpaceMachines({ slug, name }: { readonly slug: string; readonly name: string }) {
  const machines = useQuery(machinesIn(slug))
  const mine = useQuery(ownedMachines())
  const people = useQuery(peopleIn(slug))

  if (machines.isPending || mine.isPending || people.isPending) {
    return <Status>Looking for machines…</Status>
  }
  if (machines.isError || mine.isError || people.isError) {
    return <Status alert>Could not read the machines here. Try again.</Status>
  }

  return (
    <AvailableSpaceMachines
      slug={slug}
      name={name}
      machines={machines.data}
      mine={mine.data}
      canRemoveAny={people.data.find((person) => person.you)?.role === 'owner'}
    />
  )
}

function AvailableSpaceMachines({
  slug,
  name,
  machines,
  mine,
  canRemoveAny,
}: {
  readonly slug: string
  readonly name: string
  readonly machines: readonly Machine[]
  readonly mine: readonly OwnedMachine[]
  readonly canRemoveAny: boolean
}) {
  const [adding, setAdding] = useState(false)
  const present = new Set(machines.map((machine) => machine.id))
  const machinesToAdd = mine.filter((machine) => !present.has(machine.id))

  return (
    <section aria-labelledby="space-machines-title">
      <SettingsHeading
        id="space-machines-title"
        title={`Machines in ${name}`}
        action={
          <button
            className={primaryAction}
            type="button"
            aria-expanded={adding}
            aria-controls="add-machine-to-space"
            onClick={() => {
              setAdding((open) => !open)
            }}
          >
            Add machine
          </button>
        }
      />
      {adding && (
        <AddMachine
          slug={slug}
          machines={machinesToAdd}
          close={() => {
            setAdding(false)
          }}
        />
      )}
      {machines.length === 0 ? (
        <EmptyMachines />
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {machines.map((machine) => (
            <SpaceMachineRow
              key={machine.id}
              machine={machine}
              canRemove={machine.yours || canRemoveAny}
              slug={slug}
              spaceName={name}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function AddMachine({
  slug,
  machines,
  close,
}: {
  readonly slug: string
  readonly machines: readonly OwnedMachine[]
  readonly close: () => void
}) {
  const add = useAddMachineToSpace(slug)
  return (
    <div
      id="add-machine-to-space"
      className="mb-8 rounded-[8px] border border-line-firm bg-fill p-3"
    >
      <p className="m-0 text-[13px] font-medium text-ink">Choose one of your machines</p>
      {machines.length === 0 ? (
        <p className="mt-1 text-[12px] text-ink-quiet">
          There is no other connected machine to add.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {machines.map((machine) => (
            <button
              key={machine.id}
              className="flex min-h-9 items-center justify-between rounded-[6px] border-0 bg-white px-3 text-left text-[13px] text-ink hover:bg-[var(--interaction-hover)]"
              type="button"
              disabled={add.isPending}
              onClick={() => {
                add.mutate({ params: { path: { slug, id: machine.id } } }, { onSuccess: close })
              }}
            >
              <span>{machine.name}</span>
              <Presence machine={machine} />
            </button>
          ))}
        </div>
      )}
      <Link
        className="mt-3 inline-flex text-[13px] font-medium text-primary no-underline hover:underline"
        to="/connect"
        search={{ space: slug }}
      >
        Connect a new machine
      </Link>
      {add.isError && (
        <p className="mt-2 text-[12px] text-danger-ink" role="alert">
          Could not add it. Try again.
        </p>
      )}
    </div>
  )
}

function QueryState({
  pending,
  failed,
  count,
  empty,
}: {
  readonly pending: boolean
  readonly failed: boolean
  readonly count: number | undefined
  readonly empty: string
}) {
  if (pending) return <Status>Looking for your machines…</Status>
  if (failed) return <Status alert>Could not read your machines. Try again.</Status>
  if (count === 0) return <Status>{empty}</Status>
  return null
}

function Status({
  children,
  alert = false,
}: {
  readonly children: string
  readonly alert?: boolean
}) {
  return (
    <p className="py-8 text-center text-[13px] text-ink-muted" role={alert ? 'alert' : 'status'}>
      {children}
    </p>
  )
}

function MachineHeading({
  machine,
  note,
}: {
  readonly machine: ShownMachine
  readonly note: string
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[7px] bg-fill text-ink-muted">
        <Laptop aria-hidden />
      </span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="m-0 truncate text-[14px] font-semibold text-ink">{machine.name}</h3>
          <Presence machine={machine} />
        </div>
        <p className="mt-0.5 text-[12px] text-ink-quiet">{note}</p>
      </div>
    </div>
  )
}

function AccountMachineRow({ machine }: { readonly machine: OwnedMachine }) {
  const note =
    machine.spaces.length === 0
      ? 'Not available in a Space'
      : `Available in ${machine.spaces.map((space) => space.displayName).join(', ')}`
  return (
    <li className="py-5">
      <MachineHeading machine={machine} note={note} />
      <AgentList machine={machine} editable />
      <DisconnectMachine machine={machine} />
    </li>
  )
}

function SpaceMachineRow({
  machine,
  canRemove,
  slug,
  spaceName,
}: {
  readonly machine: ShownMachine
  readonly canRemove: boolean
  readonly slug: string
  readonly spaceName: string
}) {
  return (
    <li className="py-5">
      <MachineHeading machine={machine} note={`Controlled by ${machine.ownerName}`} />
      <AgentList machine={machine} editable={false} />
      {canRemove && <RemoveFromSpace machine={machine} slug={slug} spaceName={spaceName} />}
    </li>
  )
}

function Presence({ machine }: { readonly machine: ShownMachine }) {
  const here = machine.presence.state === 'here'
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] ${here ? 'text-good' : 'text-ink-quiet'}`}
    >
      <span
        className={`size-1.5 rounded-full ${here ? 'bg-good-mark' : 'bg-ink-faint'}`}
        aria-hidden
      />
      {here ? 'Online' : 'Offline'}
    </span>
  )
}

function AgentList({
  machine,
  editable,
}: {
  readonly machine: ShownMachine
  readonly editable: boolean
}) {
  if (machine.agents.length === 0) {
    return <p className="mt-3 ml-12 text-[13px] text-ink-muted max-sm:ml-0">No agents found.</p>
  }
  return (
    <ul className="mt-3 ml-12 list-none space-y-4 p-0 max-sm:ml-0">
      {machine.agents.map((agent) => (
        <li key={agent.kind}>
          <div className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center text-ink-muted [&_svg]:size-4">
              <AgentMark kind={agent.kind} />
            </span>
            <span className="text-[13px] font-medium text-ink-body">
              {agentKindName(agent.kind)}
            </span>
            <span className="text-[12px] text-ink-quiet">{agent.version}</span>
          </div>
          {editable && <AgentDecisions machineId={machine.id} agent={agent} />}
        </li>
      ))}
    </ul>
  )
}

function AgentNameField({
  name,
  placeholder,
  onBlur,
  onChange,
}: {
  readonly name: string
  readonly placeholder: string
  readonly onBlur: () => void
  readonly onChange: (name: string) => void
}) {
  return (
    <label className="grid min-h-9 grid-cols-[64px_minmax(0,1fr)] items-center gap-3 text-[12px] font-medium text-ink-muted">
      <span>Name</span>
      <input
        className="h-8 w-full max-w-[280px] rounded-[5px] border border-line-firm bg-white px-2 text-[13px] font-normal text-ink outline-none focus-visible:border-primary"
        value={name}
        maxLength={48}
        placeholder={placeholder}
        onBlur={onBlur}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
    </label>
  )
}

function AgentCapacityField({
  atOnce,
  usable,
  errorId,
  onBlur,
  onChange,
}: {
  readonly atOnce: string
  readonly usable: boolean
  readonly errorId: string
  readonly onBlur: () => void
  readonly onChange: (atOnce: string) => void
}) {
  return (
    <>
      <label className="grid min-h-9 grid-cols-[64px_minmax(0,1fr)] items-center gap-3 text-[12px] font-medium text-ink-muted">
        <span>At once</span>
        <input
          className="h-8 w-[72px] rounded-[5px] border border-line-firm bg-white px-2 text-[13px] font-normal text-ink outline-none focus-visible:border-primary"
          type="number"
          min={1}
          max={AT_ONCE_AT_MOST}
          value={atOnce}
          aria-invalid={!usable}
          aria-describedby={usable ? undefined : errorId}
          onBlur={onBlur}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
      </label>
      {!usable && (
        <p id={errorId} className="mt-2 text-[12px] text-danger-ink" role="alert">
          At once is a whole number between 1 and {AT_ONCE_AT_MOST}.
        </p>
      )}
    </>
  )
}

function AgentDecisions({
  machineId,
  agent,
}: {
  readonly machineId: string
  readonly agent: Machine['agents'][number]
}) {
  const decide = useAgentSettings()
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [atOnceDraft, setAtOnceDraft] = useState<string | null>(null)
  const atOnceError = useId()
  const name = nameDraft ?? agent.name ?? ''
  const atOnce = atOnceDraft ?? String(agent.atOnce)
  const wanted = Number(atOnce)
  const usable = usableAtOnce(wanted)
  const nextName = name.trim() === '' ? null : name.trim()
  const changed = nextName !== agent.name || wanted !== agent.atOnce
  const save = (): void => {
    if (!changed || !usable) return
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
        <AgentNameField
          name={name}
          placeholder={agentKindName(agent.kind)}
          onBlur={save}
          onChange={setNameDraft}
        />
        <AgentCapacityField
          atOnce={atOnce}
          usable={usable}
          errorId={atOnceError}
          onBlur={save}
          onChange={setAtOnceDraft}
        />
      </form>
      {decide.isError && (
        <p className="mt-2 text-[12px] text-danger-ink" role="alert">
          That could not be sent. Try again.
        </p>
      )}
    </>
  )
}

function usableAtOnce(wanted: number): boolean {
  return Number.isInteger(wanted) && wanted >= 1 && wanted <= AT_ONCE_AT_MOST
}

function DisconnectMachine({ machine }: { readonly machine: OwnedMachine }) {
  const disconnect = useDisconnectMachine()
  const [confirming, setConfirming] = useState(false)
  if (!confirming)
    return (
      <button
        className={quietDanger}
        type="button"
        onClick={() => {
          disconnect.reset()
          setConfirming(true)
        }}
      >
        Disconnect machine
      </button>
    )
  const spaces = machine.spaces.map((space) => space.displayName).join(', ')
  return (
    <div className="mt-4 ml-12 rounded-[7px] bg-danger-wash p-3 max-sm:ml-0">
      <p className="m-0 text-[13px] text-danger-quiet">
        Disconnect {machine.name}?
        {spaces === '' ? '' : ` It will stop being available in ${spaces}.`}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          className={dangerAction}
          type="button"
          disabled={disconnect.isPending}
          onClick={() => {
            disconnect.mutate({ params: { path: { id: machine.id } } })
          }}
        >
          Disconnect
        </button>
        <button
          className={secondaryAction}
          type="button"
          onClick={() => {
            disconnect.reset()
            setConfirming(false)
          }}
        >
          Cancel
        </button>
      </div>
      {disconnect.isError && (
        <p className="mt-2 text-[12px] text-danger-ink" role="alert">
          Could not disconnect it. Try again.
        </p>
      )}
    </div>
  )
}

function RemoveFromSpace({
  machine,
  slug,
  spaceName,
}: {
  readonly machine: ShownMachine
  readonly slug: string
  readonly spaceName: string
}) {
  const remove = useRemoveMachineFromSpace(slug)
  const [confirming, setConfirming] = useState(false)
  if (!confirming)
    return (
      <button
        className={quietDanger}
        type="button"
        onClick={() => {
          remove.reset()
          setConfirming(true)
        }}
      >
        Remove from {spaceName}
      </button>
    )
  return (
    <div className="mt-4 ml-12 rounded-[7px] bg-fill p-3 max-sm:ml-0">
      <p className="m-0 text-[13px] text-ink-body">
        Remove {machine.name} from {spaceName}? This does not disconnect it or affect other Spaces.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          className={dangerAction}
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate({ params: { path: { slug, id: machine.id } } })
          }}
        >
          Remove
        </button>
        <button
          className={secondaryAction}
          type="button"
          onClick={() => {
            remove.reset()
            setConfirming(false)
          }}
        >
          Cancel
        </button>
      </div>
      {remove.isError && (
        <p className="mt-2 text-[12px] text-danger-ink" role="alert">
          Could not remove it from {spaceName}. Try again.
        </p>
      )}
    </div>
  )
}

function EmptyMachines() {
  return (
    <div className="rounded-[8px] border border-dashed border-line-firm px-6 py-12 text-center">
      <Laptop className="mx-auto mb-3 text-ink-quiet" aria-hidden />
      <p className="text-[14px] font-medium text-ink-body">No machines here</p>
      <p className="mt-1 text-[13px] text-ink-quiet">
        Add one of your machines to let its Agents work in this Space.
      </p>
    </div>
  )
}
