/**
 * The second step: a machine of one's own.
 *
 * Agents run on somebody's machine, not on ours, so nothing in a Space can do anything until one
 * is here. The command carries a key instead of a code to type: making the key here *is* the
 * approving, and the page notices the machine on its own once the command runs.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { CheckCircleFill } from 'react-bootstrap-icons'
import { api } from '../../api.ts'
import { meQuery } from '../identity/me.ts'
import { AGENT_NAMES } from '../machines/machines.tsx'
import { Steps } from './steps.tsx'

function keyFor(slug: string) {
  return {
    // A query rather than an effect-fired mutation: the key is made once per arrival, and the
    // cache is what keeps a strict-mode double mount from minting two.
    queryKey: ['machine-key', slug] as const,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await api.POST('/spaces/{slug}/machine-keys', {
        params: { path: { slug } },
      })
      if (data === undefined) throw new Error(error.reason)
      return data
    },
  }
}

function machinesIn(slug: string) {
  return {
    queryKey: ['machines', slug] as const,
    // The terminal takes as long as it takes; the page keeps asking so nobody refreshes.
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

/** The command, its key, and the two ways a key stops being usable. */
function KeyCommand({ slug, arrived }: { readonly slug: string; readonly arrived: boolean }) {
  const client = useQueryClient()
  const key = useQuery(keyFor(slug))
  /** Set by a timer aimed at the key's own expiry; a clock read mid-render is impure. */
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    if (key.data === undefined) return
    const t = setTimeout(
      () => {
        setExpired(true)
      },
      Math.max(new Date(key.data.expiresAt).getTime() - Date.now(), 0),
    )
    return () => {
      clearTimeout(t)
    }
  }, [key.data])

  if (key.isPending) return <p className="empty">Preparing the command…</p>

  if (key.isError || (expired && !arrived)) {
    return (
      <>
        <p className="note">
          {expired ? 'That key expired; they live fifteen minutes.' : 'Could not make a key.'}
        </p>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => {
            void client.resetQueries({ queryKey: ['machine-key', slug] })
          }}
        >
          <span className="button-label">Make another</span>
        </button>
      </>
    )
  }

  return (
    <>
      <div className="auth-command-row">
        <code className="field auth-command">handover connect --key {key.data.key}</code>
        <Copy text={`handover connect --key ${key.data.key}`} />
      </div>
      {!arrived && (
        <p className="note">Waiting for it to check in — this page notices on its own.</p>
      )}
    </>
  )
}

/** The whole point of the command is being pasted elsewhere; make that one click. */
function Copy({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  return (
    <button
      className="button button-secondary"
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        timer.current = setTimeout(() => {
          setCopied(false)
        }, 1600)
      }}
    >
      <span className="button-label">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

/** The machines that arrived, with what each of them found. */
function Arrived({ slug }: { readonly slug: string }) {
  const machines = useQuery(machinesIn(slug))
  const found = (machines.data ?? []).filter((machine) => machine.presence.state === 'here')

  if (found.length === 0) return null

  return (
    <div className="stack-tight">
      {found.map((machine) => (
        <p key={machine.id} className="said said-good">
          <CheckCircleFill aria-hidden />
          <span>
            <strong>{machine.name}</strong> is in.
            {machine.agents.length === 0
              ? ' No agents found on it yet.'
              : ` It found: ${machine.agents
                  .map((agent) => `${AGENT_NAMES[agent.kind] ?? agent.kind} ${agent.version}`)
                  .join(' · ')}`}
          </span>
        </p>
      ))}
    </div>
  )
}

/** The Space this step is for: named in the address, or the only one there is. */
function useHostSpace(forSlug: string | undefined): {
  readonly slug: string | undefined
  readonly name: string | undefined
} {
  const navigate = useNavigate()
  const me = useQuery(meQuery)
  const spaces = me.data?.spaces ?? []
  const slug = forSlug ?? (spaces.length === 1 ? spaces[0]?.slug : undefined)

  useEffect(() => {
    // The address naming a Space is proof enough: the form that made it just sent us here, and
    // the /me cache may not have caught up. Only without one do we look at the list — and then
    // exactly one is derivable, anything else goes back to the step that makes or picks it.
    if (me.isSuccess && forSlug === undefined && spaces.length !== 1) {
      void navigate({ to: '/onboarding', replace: true })
    }
  }, [me.isSuccess, spaces.length, forSlug, navigate])

  return { slug, name: spaces.find((one) => one.slug === slug)?.displayName }
}

/** The way out: the Space once a machine is in, looking around first when it is not. */
function Leave({
  arrived,
  spaceName,
  onGo,
}: {
  readonly arrived: boolean
  readonly name: string | undefined
  readonly spaceName: string | undefined
  readonly onGo: () => void
}) {
  if (arrived) {
    return (
      <button className="button button-primary" type="button" onClick={onGo}>
        <span className="button-label">Open {spaceName ?? 'your Space'}</span>
      </button>
    )
  }
  return (
    <button className="button button-quiet auth-skip" type="button" onClick={onGo}>
      <span className="button-label">Not now — look around first</span>
    </button>
  )
}

export function ConnectHost({ forSlug }: { readonly forSlug: string | undefined }) {
  const navigate = useNavigate()
  const { slug, name } = useHostSpace(forSlug)
  /** Where somebody clicked their way in. The bar sweeps to the end before the page follows. */
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
    }
  }, [])

  const machines = useQuery({ ...machinesIn(slug ?? ''), enabled: slug !== undefined })
  const arrived = (machines.data ?? []).some((machine) => machine.presence.state === 'here')

  const goIn = () => {
    if (slug === undefined) return
    setLeaving(true)
    timer.current = setTimeout(() => {
      void navigate({ to: '/s/$slug', params: { slug } })
    }, 520)
  }

  return (
    <main className="auth">
      <div className="auth-stack">
        <Steps step={2} done={leaving} mark={leaving || arrived ? 'success' : 'working'} />

        <div className="auth-head">
          <h1>Connect a machine</h1>
          <p className="lede">
            Agents run on <strong>your</strong> machine, not on ours. Run this in its terminal:
          </p>
        </div>

        {slug !== undefined && (
          <div className="stack-tight">
            <KeyCommand slug={slug} arrived={arrived} />
            <Arrived slug={slug} />
          </div>
        )}

        <Leave arrived={arrived} name={name} spaceName={name} onGo={goIn} />
      </div>
    </main>
  )
}
