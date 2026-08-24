import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const oxlint = join(root, 'node_modules', '.bin', 'oxlint')
let fixtureRoot = ''

type LintRun = {
  readonly status: number
  readonly output: string
}

function lint(source: string): LintRun {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'handover-lint-'))
  const fixture = join(fixtureRoot, 'fixture.ts')
  writeFileSync(fixture, source)

  const result = spawnSync(
    oxlint,
    [
      '--config',
      join(root, '.oxlintrc.json'),
      '--tsconfig',
      join(root, 'tsconfig.json'),
      '--format',
      'json',
      fixture,
    ],
    { cwd: root, encoding: 'utf8' },
  )
  if (result.error) throw result.error

  return {
    status: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  }
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

describe('lint rules', () => {
  it('rejects method signatures that bypass strict function parameter checking', () => {
    const result = lint('export interface Adapter { execute(command: string): void }\n')

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('typescript(method-signature-style)')
  })

  it('accepts function properties that receive strict function parameter checking', () => {
    const result = lint('export interface Adapter { execute: (command: string) => void }\n')

    expect(result.status).toBe(0)
  })

  it('rejects reading process.env outside the module that parses it', () => {
    const result = lint('export const url = process.env.DATABASE_URL\n')

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('no-restricted-properties')
  })

  it('exempts the module that parses the environment', () => {
    const result = spawnSync(oxlint, ['--config', join(root, '.oxlintrc.json'), 'src/env.ts'], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
  })

  it('rejects classes used only as static namespaces', () => {
    const result = lint('export class WorkRules { static accept(): boolean { return true } }\n')

    expect(result.status).not.toBe(0)
    expect(result.output).toContain('typescript(no-extraneous-class)')
  })
})
