/**
 * That nobody who was removed is still being answered.
 *
 * This is the failure this slice ships most easily, and it is silent: somebody taken out of a
 * Space who can still reach its machines, or who still gets its work in their Inbox. Nothing
 * breaks, no test goes red, and the only symptom is a person seeing something they should not.
 *
 * Membership and machine availability are read from many places — the door on every Space route,
 * whether a machine can be reached, whose machines a Space lists, whose work is waiting. Each
 * query has to exclude the rows whose relationship ended, and one forgetting looks exactly like
 * the others.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const DB = 'apps/server/src/db'

const ENDING = [
  { table: 'memberships', column: 'revoked_at' },
  { table: 'space_machines', column: 'removed_at' },
] as const

const TOUCHES_EXISTING_ROWS = new Set([
  'selectFrom',
  'updateTable',
  'deleteFrom',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
])

type Query = {
  readonly table: (typeof ENDING)[number]['table']
  readonly column: (typeof ENDING)[number]['column']
  readonly line: number
  readonly source: string
}

function outerQuery(query: ts.Node): ts.Node {
  const parent = query.parent
  const continuesProperty = ts.isPropertyAccessExpression(parent) && parent.expression === query
  const callsProperty = ts.isCallExpression(parent) && parent.expression === query
  if (!continuesProperty && !callsProperty) return query

  return outerQuery(parent)
}

function relationshipRead(node: ts.Node, file: ts.SourceFile): Query | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
    return undefined

  const method = node.expression.name.text
  const tableArgument = node.arguments[0]
  if (!TOUCHES_EXISTING_ROWS.has(method) || tableArgument === undefined) return undefined
  if (!ts.isStringLiteral(tableArgument)) return undefined

  const ending = ENDING.find(
    ({ table }) => tableArgument.text === table || tableArgument.text.startsWith(`${table} as `),
  )
  if (ending === undefined) return undefined

  const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  return {
    table: ending.table,
    column: ending.column,
    line,
    source: outerQuery(node).getText(file),
  }
}

/** Every query-builder chain that reads a relationship, including relationships joined later. */
function queries(path: string, source: string): readonly Query[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Query[] = []

  function visit(node: ts.Node): void {
    const query = relationshipRead(node, file)
    if (query !== undefined) found.push(query)

    ts.forEachChild(node, visit)
  }

  visit(file)
  return found
}

function everySource(from: string): readonly string[] {
  return readdirSync(from).flatMap((entry) => {
    const path = join(from, entry)
    if (statSync(path).isDirectory()) return everySource(path)

    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

/** A query that reads a revocable relationship and never says which rows still count. */
function forgetful(): readonly string[] {
  return everySource(DB).flatMap((path) => {
    const source = readFileSync(path, 'utf8')

    return queries(path, source).flatMap((query) => {
      if (query.source.includes(query.column)) return []

      return [
        `${path.replace(`${DB}/`, '')}:${String(query.line)} reads ${query.table} without ${query.column}`,
      ]
    })
  })
}

describe('reading a relationship that can end', () => {
  it('never forgets to leave out people or machines that were removed', async () => {
    // An insert is exempt by shape: it names no existing rows to filter. Reading, updating or
    // deleting a relationship without saying which rows still count is the whole of this rule.
    expect(forgetful()).toEqual([])
  })
})
