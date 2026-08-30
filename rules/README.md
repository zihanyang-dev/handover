# rules

What this repository asks of itself, as tests. `pnpm test` runs them; they are also a vitest
project of their own, so `pnpm exec vitest run --project rules` is all of them and nothing else.

They are here rather than under any package because that is what they are about: every one reads
paths from the repository root, and several cross packages — the import order covers the server,
the CLI, the browser app and the end-to-end suite; the endpoint check reads `docs/`; the contract
check holds a screen against what the server publishes.

**Every one of them was written after the problem it now asks about.** None is a rule somebody
thought would be nice. Where the story is short it is in the file's own first paragraph, and
where it is long the file says what was found and how.

|                  | asks that                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `api-files.spec` | every `-api.ts` is laid out the same way                                                 |
| `clocks`         | a column saying when something happened is stamped by the wall clock                     |
| `colours`        | a colour is written in a stylesheet and only ever named on a screen                      |
| `contract`       | no screen writes down a shape the contract already publishes                             |
| `endpoints`      | every endpoint a design document names is one this deployment really has                 |
| `generated`      | what is committed under `generated/` came from this branch's migrations and nothing else |
| `imports`        | every file lists what it needs in the same order, and each module once                   |
| `pointers`       | a file a comment points at in backticks is a file that is here                           |
| `reachable`      | every endpoint this deployment has is one something can actually reach                   |
| `refusals`       | every refusal a screen reads by name is one this server can actually send                |
| `revoked`        | nobody who was removed is still being answered                                           |
| `routes`         | every route is behind the door its address promises                                      |
| `shapes`         | every thing the contract carries has a name, and that no two things share one            |
| `sql`            | SQL written by hand appears only on a list somebody changed on purpose                   |
| `style`          | a class a screen names is one the build has something for                                |

## Adding one

Only after something has gone wrong that reading could not have caught, and only when the answer
can be asked mechanically. A rule that needs judgement is a review comment, not a test — and a
rule nothing has ever violated is a rule nobody can tell is still true.

Write it so its failure names the file and the thing, because whoever meets it will be somebody
who has never read this directory.
