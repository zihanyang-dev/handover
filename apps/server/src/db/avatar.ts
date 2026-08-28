import type { AvatarSubject } from '../avatar.ts'
import type { Database } from './connection.ts'

/** Whether an avatar subject exists before permanent bytes are generated for it. */
export async function avatarSubjectExists(db: Database, subject: AvatarSubject): Promise<boolean> {
  if (subject.kind === 'user') {
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', subject.userId)
      .executeTakeFirst()
    return user !== undefined
  }

  const agent = await db
    .selectFrom('agents')
    .select('machine_id')
    .where('machine_id', '=', subject.machineId)
    .where('kind', '=', subject.agentKind)
    .executeTakeFirst()
  return agent !== undefined
}
