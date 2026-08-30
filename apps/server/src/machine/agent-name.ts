/**
 * A stable name for an agent whose owner did not choose one.
 *
 * Drawn from the machine and kind rather than on every read: the result looks incidental but the
 * same agent keeps the same face everywhere and across restarts.
 */
const NAMES = [
  'Atlas',
  'Clover',
  'Comet',
  'Echo',
  'Juniper',
  'Lumen',
  'Maple',
  'Mica',
  'Nova',
  'Orion',
  'Pico',
  'Sage',
  'Sol',
  'Taro',
  'Vega',
  'Willow',
] as const

export function fallbackAgentName(machineId: string, kind: string): string {
  let hash = 2_166_136_261
  for (const character of `${machineId}:${kind}`) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return NAMES[(hash >>> 0) % NAMES.length] ?? NAMES[0]
}
