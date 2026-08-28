/**
 * What a person may choose for one question: which model, and how hard to think.
 *
 * The offers come from the agent itself and may be empty — an agent that lets you choose nothing
 * shows no control here rather than an empty menu. Saying nothing is always allowed and means the
 * agent's own default, so neither choice is ever required to send.
 */

import type { components } from '../../generated/api.ts'
import { AgentMark, agentName, agentTint } from '../machines/agent.tsx'
import { ChoiceMenu, compactAbout, type Choice } from './choice-menu.tsx'

export type Model = components['schemas']['Model']
type Asked = components['schemas']['OpenConversation']['asked']

export function askedWithChoices(text: string, model: string, effort: string): Asked {
  const asked: Asked = { text }
  if (model !== '') asked.model = model
  if (effort !== '') asked.effort = effort
  return asked
}

export function ModelChoices({
  offers,
  agentKind,
  model,
  effort,
  onModel,
  onEffort,
}: {
  readonly offers: readonly Model[]
  readonly agentKind: string
  readonly model: string
  readonly effort: string
  readonly onModel: (model: string) => void
  readonly onEffort: (effort: string) => void
}) {
  if (offers.length === 0) return null

  const auto: Choice = { value: '', label: 'Auto', about: 'Balances speed, effort, and cost.' }
  const activeModel =
    offers.find((offer) => offer.id === model) ??
    offers.find((offer) => offer.isDefault) ??
    offers[0]
  const efforts = choicesForEffort(activeModel)

  // No `ml-auto` of its own: a screen with a second chooser beside this one puts both in one
  // group and pushes that group. Two elements each claiming the free space would split it, and
  // the gap would open up between them.
  return (
    <div className="flex min-w-0 gap-1.5">
      <ChoiceMenu
        label="Model"
        section={agentName(agentKind)}
        saysNothing={auto}
        alternatives={offers.map(asModelChoice)}
        value={model}
        onChange={onModel}
        mark={
          <span
            className={`grid size-5 flex-none place-items-center [&>svg]:size-4 ${agentTint(agentKind)}`}
            aria-hidden="true"
          >
            <AgentMark kind={agentKind} />
          </span>
        }
      />
      {efforts.alternatives.length > 0 && (
        <ChoiceMenu
          label="Thinking"
          section="Thinking"
          saysNothing={efforts.saysNothing}
          alternatives={efforts.alternatives}
          value={effort}
          onChange={onEffort}
        />
      )}
    </div>
  )
}

/** What may be chosen about how hard to think, if this model lets anybody choose at all. */
function choicesForEffort(model: Model | undefined): {
  readonly saysNothing: Choice
  readonly alternatives: readonly Choice[]
} {
  if (model === undefined || model.efforts.length === 0) {
    return { saysNothing: { value: '', label: 'Default' }, alternatives: [] }
  }

  return {
    saysNothing: { value: '', label: 'Default', about: defaultEffort(model) },
    alternatives: model.efforts.map((effort) => ({ value: effort, label: titled(effort) })),
  }
}

function defaultEffort(model: Model): string {
  return model.defaultEffort === undefined
    ? 'Use the agent default.'
    : `Uses ${titled(model.defaultEffort)}.`
}

function titled(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function asModelChoice(offer: Model): Choice {
  const choice = { value: offer.id, label: offer.name }
  const about = modelDetail(offer.about)
  if (about === undefined) return choice
  return { ...choice, about }
}

function modelDetail(about: string | undefined): string | undefined {
  if (about === undefined) return undefined
  const detail = compactAbout(about)
  return /\d/u.test(detail) ? detail : undefined
}
