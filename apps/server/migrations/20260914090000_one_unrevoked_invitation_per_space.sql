-- A Space has one invitation link at a time.
--
-- A list of indistinguishable active links cannot be copied again and cannot tell somebody which
-- one they are disabling. Replacing the link is one transaction instead: the old credential stops
-- before the new plaintext is handed back. The database keeps a late writer from opening a second
-- one even if a caller forgets that rule.

-- migrate:up

-- Keep the newest existing link. Older ones have already lost their plaintext, so retaining several
-- gives nobody another action except guessing which one to revoke.
with open_invitations as (
  select id,
         row_number() over (partition by space_id order by created_at desc, id desc) as newest
    from invitations
   where revoked_at is null
)
update invitations i
   set revoked_at = clock_timestamp()
  from open_invitations open
 where open.newest > 1
   and i.id = open.id;

drop index invitations_open;
create unique index invitations_one_unrevoked_per_space
  on invitations (space_id)
  where revoked_at is null;

-- migrate:down

drop index invitations_one_unrevoked_per_space;
create index invitations_open on invitations (space_id) where revoked_at is null;
