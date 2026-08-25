-- The agents this deployment knows how to find and drive.
--
-- Two, not three. Driving an agent means an adapter against the SDK its own makers publish, and
-- both of these have one that runs the copy already installed on the machine — the copy holding
-- that person's login. Cursor Agent publishes nothing of the kind, so an entry for it would be a
-- kind of agent no machine could ever be asked to run.
--
-- The list is here and in `agent-kind.ts`, and a test says the two are the same list, so this
-- constraint is the reason that test can fail.

-- migrate:up

alter table agents drop constraint agents_kind_check;
alter table agents add constraint agents_kind_check check (kind in ('claude-code', 'codex'));

-- migrate:down

alter table agents drop constraint agents_kind_check;
alter table agents add constraint agents_kind_check check (kind in ('claude-code', 'codex', 'cursor-agent'));
