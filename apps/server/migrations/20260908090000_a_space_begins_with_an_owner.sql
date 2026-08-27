-- A Space with no owner is a Space nobody can ever be let into.
--
-- The rule that keeps one was written to catch the three ways the last owner can *go* — leaving,
-- being removed, being demoted — and it missed the fourth: a Space arriving without one. That is
-- not a hypothetical; every Space made between the two migrations had exactly that shape, because
-- `role` defaults to 'member' and nothing said otherwise.
--
-- The caller says `role: 'owner'` now, and the trigger covers the insert as well, so it is true of
-- a Space however it came to exist rather than because one writer remembered.

-- migrate:up

update memberships m set role = 'owner'
 where not exists (
   select 1 from memberships other
    where other.space_id = m.space_id and other.role = 'owner' and other.revoked_at is null
 )
   and m.revoked_at is null
   and m.created_at = (
     select min(first.created_at) from memberships first
      where first.space_id = m.space_id and first.revoked_at is null
   );

drop trigger memberships_keep_an_owner on memberships;

create constraint trigger memberships_keep_an_owner
  after insert or update or delete on memberships
  deferrable initially deferred
  for each row execute function a_space_keeps_an_owner();

-- migrate:down

drop trigger memberships_keep_an_owner on memberships;

create constraint trigger memberships_keep_an_owner
  after update or delete on memberships
  deferrable initially deferred
  for each row execute function a_space_keeps_an_owner();
