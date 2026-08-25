-- The agents this deployment knows how to find and drive.
--
-- Two, not three. Driving an agent means the Agent Client Protocol, and only Claude Code and
-- Codex have adapters maintained by the protocol's own organisation. Cursor Agent has none;
-- Pi's is third party and drops the tools we hand it, which would leave an agent that looks
-- busy and cannot say a word — the worst way for this to fail.
--
-- The list is here and in `agent-kind.ts`, and a test says the two are the same list, so this
-- constraint is the reason that test can fail.

-- migrate:up

alter table agents drop constraint agents_kind_check;
alter table agents add constraint agents_kind_check check (kind in ('claude-code', 'codex'));

-- migrate:down

alter table agents drop constraint agents_kind_check;
alter table agents add constraint agents_kind_check check (kind in ('claude-code', 'codex', 'cursor-agent'));
