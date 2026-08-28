-- The name was the first decision an owner made about an agent; how many things it may run at
-- once is the second.
--
-- Same table for the same reason that table was made: discovery replaces the whole reported set
-- on every check-in, and neither of these may be erased by a scan that came back short. Renamed
-- rather than added beside, because "the name of an agent" was never what it held — it held what
-- its owner decided about it, and there is now more than one such decision.

-- migrate:up

alter table agent_names rename to agent_settings;
alter index agent_names_pkey rename to agent_settings_pkey;
alter table agent_settings rename constraint agent_names_machine_id_fkey to agent_settings_machine_id_fkey;
alter table agent_settings rename constraint agent_names_kind_check to agent_settings_kind_check;
alter table agent_settings rename constraint agent_names_name_check to agent_settings_name_check;
alter table agent_settings rename column named_at to decided_at;

-- Nullable now: a person who says "at most one at a time" and never names it has decided
-- something, and there is no name to invent for them.
alter table agent_settings alter column name drop not null;

-- Three, and it is a judgement rather than a measurement. One leaves `07` delivering nothing on
-- the common machine, which has a single agent on it; two leaves a third piece of work queued
-- behind the promise that it would not be. Bounded because it is a person typing into a box, and
-- a laptop asked for a thousand agents fails in a way nobody can read. Both numbers are also
-- written in `machine/at-once.ts`, and `machine.spec.ts` holds the two copies to each other.
alter table agent_settings
  add column at_once int not null default 3
  constraint agent_settings_at_once_check check (at_once between 1 and 16);

-- migrate:down

alter table agent_settings drop column at_once;
alter table agent_settings rename column decided_at to named_at;
delete from agent_settings where name is null;
alter table agent_settings alter column name set not null;
alter table agent_settings rename constraint agent_settings_name_check to agent_names_name_check;
alter table agent_settings rename constraint agent_settings_kind_check to agent_names_kind_check;
alter table agent_settings rename constraint agent_settings_machine_id_fkey to agent_names_machine_id_fkey;
alter index agent_settings_pkey rename to agent_names_pkey;
alter table agent_settings rename to agent_names;
