/**
 * Builds the single file a machine runs.
 *
 * One binary with nothing underneath it: no Node to install, no package manager, no runtime that
 * can be upgraded out from under it. The machines this lands on are somebody's laptop and
 * somebody's server, and the second one is why "install Node first" is not an answer.
 *
 * Every supported platform is built from one host, because Bun cross-compiles — so a release is
 * one job rather than one job per operating system, and every asset in it comes from the same
 * source at the same moment.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, 'dist')

/**
 * What gets built, and what each is called where somebody downloads it.
 *
 * No 32-bit anything and no Windows: the first has no machines left worth the download, and the
 * second has no service manager this program knows how to hand itself to.
 */
const TARGETS = [
  { asset: 'handover-darwin-arm64', bun: 'bun-darwin-arm64' },
  { asset: 'handover-darwin-x64', bun: 'bun-darwin-x64' },
  { asset: 'handover-linux-x64', bun: 'bun-linux-x64' },
  { asset: 'handover-linux-arm64', bun: 'bun-linux-arm64' },
] as const

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const target of TARGETS) {
  execFileSync(
    join(ROOT, 'node_modules', '.bin', 'bun'),
    [
      'build',
      join(ROOT, 'src', 'main.ts'),
      '--compile',
      '--minify',
      `--target=${target.bun}`,
      // Writes the tag into the code rather than reading it at run time. Narrow on purpose: this
      // inlines every environment variable it matches, and a wider pattern would bake whatever
      // else the release machine happened to be holding into a public download.
      '--env=HANDOVER_VERSION*',
      '--outfile',
      join(OUT, target.asset),
    ],
    { stdio: 'inherit' },
  )
}

process.stdout.write(`${TARGETS.map((target) => target.asset).join('\n')}\n`)
