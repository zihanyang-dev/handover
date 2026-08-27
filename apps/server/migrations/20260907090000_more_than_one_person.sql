-- A Space can have more than one person in it.
--
-- Everything downstream was already written for a second person — reachability is a join over
-- `memberships`, a machine row says whose it is, the Disconnect button is hidden on somebody
-- else's — and until now no product path could produce one. This is that path.

-- migrate:up

-- What somebody may do in a Space, and nothing finer. Two values, and a check rather than a table:
-- a table invites a third. Linear and Notion have no custom roles at any tier, and they are much
-- larger than this. See `roadmap/05-more-than-one-person/design.md`.
alter table memberships add column role text not null default 'member'
  constraint memberships_role_known check (role in ('owner', 'member'));

-- Every Space today has exactly one member: whoever made it. They are its owner.
update memberships set role = 'owner';

-- Removing somebody revokes their membership rather than deleting the row. GitHub keeps a removed
-- member's data for three months, Notion restores everything if they rejoin within thirty days,
-- and Linear has no permanent delete at all — three products, one answer. Keeping the row also
-- makes re-inviting the same person put back exactly what they had, with no window to expire.
alter table memberships add column revoked_at timestamptz;

-- Read on every request that asks what a Space can see. Partial, because the revoked rows are
-- history and no live question is ever about them.
create index memberships_here on memberships (space_id, user_id) where revoked_at is null;

/*
 * An invitation, shaped exactly like an enrolment.
 *
 * The two answer the same question — how does something with no identity yet prove it is allowed
 * in — so this is not a second mechanism, down to only ever storing the hash. No `email` column:
 * a link works for whoever holds it, and that is said on the screen rather than papered over with
 * a field nothing checks.
 */
create table invitations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  secret_hash text not null unique,
  made_by uuid not null references users(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index invitations_open on invitations (space_id) where revoked_at is null;

/*
 * A Space always has at least one owner.
 *
 * Not something a caller remembers: three paths can take the last one away — leaving, being
 * removed, and being demoted — and a rule with three writers is a rule that gets forgotten by
 * one of them. A unique index cannot say "at least one", so this is a constraint trigger,
 * deferred to the end of the transaction: a demotion followed by a promotion inside one
 * transaction is fine, and only the state at commit has to be true.
 *
 * GitHub refuses to let the last owner leave and says so in words; this is the half that cannot
 * be got around, and the words live in the code that catches it.
 */
create function a_space_keeps_an_owner() returns trigger as $$
begin
  if not exists (
    select 1 from memberships
     where space_id = coalesce(new.space_id, old.space_id)
       and role = 'owner'
       and revoked_at is null
  ) then
    raise exception 'a Space must have at least one owner'
      using errcode = 'check_violation', constraint = 'memberships_keep_an_owner';
  end if;

  return null;
end;
$$ language plpgsql;

create constraint trigger memberships_keep_an_owner
  after update or delete on memberships
  deferrable initially deferred
  for each row execute function a_space_keeps_an_owner();

-- migrate:down

drop trigger memberships_keep_an_owner on memberships;
drop function a_space_keeps_an_owner();
drop table invitations;
drop index memberships_here;
alter table memberships drop column revoked_at;
alter table memberships drop column role;
