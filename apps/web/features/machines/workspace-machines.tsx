import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ExclamationTriangle, Laptop } from 'react-bootstrap-icons'
import type { components } from '../../generated/api.ts'
import { peopleIn } from '../spaces/people.ts'
import { AgentMark, agentKindName } from './agent.tsx'
import {
  machinesIn,
  useDisconnectMachine,
  useHandMachineTo,
  useNameAgent,
  type Machine,
} from './machine-list.ts'

type Member = components['schemas']['Member']

export function WorkspaceMachines({ slug }: { readonly slug: string }) {
  const machines = useQuery(machinesIn(slug))
  const people = useQuery(peopleIn(slug))
  const own = people.data?.find((person) => person.you)
  const canTransfer = own?.role === 'owner'

  if (machines.isPending || people.isPending) return <PanelState>Looking for machines…</PanelState>
  if (machines.isError || people.isError)
    return <PanelState>Could not read the machines here. Try again.</PanelState>

  return (
    <section aria-labelledby="workspace-machines-title">
      <header className="mb-8">
        <h1
          id="workspace-machines-title"
          className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-[#2f2e2b]"
        >
          Machines
        </h1>
        <p className="mt-1 text-[14px] leading-5 text-[#666460]">
          See where agents run and manage the machines that belong to you.
        </p>
      </header>
      {machines.data.length === 0 ? (
        <EmptyMachines />
      ) : (
        <ul className="m-0 list-none divide-y divide-[#e9e8e6] border-y border-[#e9e8e6] p-0">
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
  const disconnect = useDisconnectMachine(slug)
  const transfer = useHandMachineTo(slug)
  const [confirming, setConfirming] = useState(false)
  // The response names the owner for people but does not expose their id. Names are not unique,
  // so filtering by the visible name would sometimes remove the wrong person from this choice.
  const recipients = people
  const [ownerUserId, setOwnerUserId] = useState(recipients.at(0)?.userId ?? '')

  return (
    <li className="py-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[7px] bg-[#f2f1ef] text-[#777570]">
          <Laptop aria-hidden />
        </span>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="truncate text-[14px] font-semibold text-[#373633]">{machine.name}</h2>
            <Presence machine={machine} />
          </div>
          <p className="mt-0.5 text-[12px] leading-[17px] text-[#898781]">
            {machine.yours ? 'Yours' : machine.ownerName}
            {machine.version === undefined ? '' : ` · handover ${machine.version}`}
          </p>
          {machine.connectedIn !== undefined && (
            <p className="mt-1 truncate font-mono text-[12px] leading-[17px] text-[#777570]">
              {machine.connectedIn}
            </p>
          )}
        </div>
      </div>
      <AgentSettings slug={slug} machine={machine} />
      <div className="mt-4 ml-12 flex flex-wrap items-center gap-2 max-sm:ml-0">
        {canTransfer && recipients.length > 0 && (
          <TransferMachine
            slug={slug}
            machine={machine}
            recipients={recipients}
            ownerUserId={ownerUserId}
            setOwnerUserId={setOwnerUserId}
            transfer={transfer}
          />
        )}
        {machine.yours && (
          <DisconnectMachine
            machine={machine}
            confirming={confirming}
            setConfirming={setConfirming}
            disconnect={disconnect}
          />
        )}
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
          ? 'inline-flex items-center gap-1 text-[12px] text-[#4c7a4b]'
          : 'inline-flex items-center gap-1 text-[12px] text-[#898781]'
      }
    >
      <span
        className={
          here ? 'size-1.5 rounded-full bg-[#4c9a55]' : 'size-1.5 rounded-full bg-[#aaa8a3]'
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
      <p className="mt-4 rounded-[7px] bg-[#f7f6f4] p-3 text-[13px] text-[#777570]">
        No agents found on this machine.
      </p>
    )

  return (
    <ul className="mt-4 ml-12 list-none divide-y divide-[#efeeec] rounded-[7px] border border-[#e9e8e6] p-0 max-sm:ml-0">
      {machine.agents.map((agent) => (
        <AgentRow key={agent.kind} slug={slug} machine={machine} agent={agent} />
      ))}
    </ul>
  )
}

function AgentRow({
  slug,
  machine,
  agent,
}: {
  readonly slug: string
  readonly machine: Machine
  readonly agent: Machine['agents'][number]
}) {
  const naming = useNameAgent(slug)

  return (
    <li className="p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center text-[#777570] [&_svg]:size-4">
          <AgentMark kind={agent.kind} />
        </span>
        <span className="text-[13px] font-medium text-[#454440]">{agentKindName(agent.kind)}</span>
        <span className="text-[12px] text-[#9a9893]">{agent.version}</span>
      </div>
      {machine.yours && (
        <form
          className="mt-3 flex items-end gap-2 max-sm:flex-col max-sm:items-stretch"
          onSubmit={(event) => {
            event.preventDefault()
            const name = event.currentTarget.elements.namedItem('name')
            const atOnce = event.currentTarget.elements.namedItem('atOnce')
            if (!(name instanceof HTMLInputElement) || !(atOnce instanceof HTMLInputElement)) return
            if (!Number.isInteger(atOnce.valueAsNumber)) return
            naming.mutate({
              params: { path: { id: machine.id, kind: agent.kind } },
              body: {
                name: name.value.trim() === '' ? null : name.value.trim(),
                atOnce: atOnce.valueAsNumber,
              },
            })
          }}
        >
          <label className="min-w-0 grow text-[12px] font-medium text-[#777570]">
            Name
            <input
              className="mt-1 block h-8 w-full rounded-[5px] border border-[#d7d5d2] bg-white px-2 text-[13px] font-normal text-[#373633] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
              name="name"
              defaultValue={agent.name ?? ''}
              maxLength={48}
              placeholder={agentKindName(agent.kind)}
            />
          </label>
          <label className="w-[92px] shrink-0 text-[12px] font-medium text-[#777570]">
            At once
            <input
              className="mt-1 block h-8 w-full rounded-[5px] border border-[#d7d5d2] bg-white px-2 text-[13px] font-normal text-[#373633] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0075de]"
              name="atOnce"
              type="number"
              min={1}
              max={16}
              defaultValue={agent.atOnce}
            />
          </label>
          <button
            className="h-8 shrink-0 rounded-[5px] border border-[#d7d5d2] px-3 text-[13px] font-medium text-[#4f4d49] hover:bg-[#f5f4f2] disabled:opacity-45"
            type="submit"
            disabled={naming.isPending}
          >
            Save
          </button>
        </form>
      )}
      {naming.isError && (
        <p className="mt-2 text-[12px] text-[#b42318]" role="alert">
          Could not save that name. Try again.
        </p>
      )}
    </li>
  )
}

function TransferMachine({
  slug,
  machine,
  recipients,
  ownerUserId,
  setOwnerUserId,
  transfer,
}: {
  readonly slug: string
  readonly machine: Machine
  readonly recipients: readonly Member[]
  readonly ownerUserId: string
  readonly setOwnerUserId: (id: string) => void
  readonly transfer: ReturnType<typeof useHandMachineTo>
}) {
  return (
    <>
      <select
        className="h-8 max-w-[220px] rounded-[5px] border border-[#d7d5d2] bg-white px-2 text-[13px] text-[#5f5d59]"
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
        className="h-8 rounded-[5px] border border-[#d7d5d2] px-2 text-[13px] font-medium text-[#4f4d49] hover:bg-[#f5f4f2] disabled:opacity-45"
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
    </>
  )
}

function DisconnectMachine({
  machine,
  confirming,
  setConfirming,
  disconnect,
}: {
  readonly machine: Machine
  readonly confirming: boolean
  readonly setConfirming: (confirming: boolean) => void
  readonly disconnect: ReturnType<typeof useDisconnectMachine>
}) {
  if (!confirming)
    return (
      <button
        className="h-8 rounded-[5px] border-0 bg-transparent px-2 text-[13px] font-medium text-[#9b2c2c] hover:bg-[#fdf0ef]"
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
    <div className="w-full rounded-[7px] border border-[#f1cbc8] bg-[#fff7f6] p-3">
      <p className="flex items-start gap-2 text-[13px] leading-[18px] text-[#7d2925]">
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
          className="h-8 rounded-[5px] border-0 bg-[#d44c47] px-3 text-[13px] font-medium text-white disabled:opacity-45"
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
    <div className="rounded-[8px] border border-dashed border-[#c9c7c2] px-6 py-12 text-center">
      <Laptop className="mx-auto mb-3 text-[#898781]" aria-hidden />
      <p className="text-[14px] font-medium text-[#454440]">No machines here</p>
      <p className="mt-1 text-[13px] text-[#898781]">
        Run handover connect on the machine where an agent should work.
      </p>
    </div>
  )
}

function PanelState({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="py-10 text-center text-[14px] text-[#777570]" role="status">
      {children}
    </p>
  )
}
