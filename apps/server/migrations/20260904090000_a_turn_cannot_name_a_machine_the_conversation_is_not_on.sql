-- A turn names the machine running it, and a conversation names the machine it is on. The same
-- fact, written twice.
--
-- The copy stays, because it earns its keep: `turns_open_on_machine` is a partial index that
-- answers "is this machine busy" — the hottest question here, asked on every report a machine
-- makes — without touching `conversations` at all. Joined instead, the poll pays for it forever.
--
-- What is not acceptable is that the two could disagree and nothing would say so. A composite
-- foreign key makes the disagreement impossible to write, which is where a rule like this belongs:
-- `code-style.md` 9 — a late writer has to fail in SQL, not only in TypeScript.
--
-- It replaces the plain reference to `machines`, rather than sitting beside it: a turn whose
-- conversation is on a machine is a turn on a machine that exists.

-- migrate:up

alter table conversations add constraint conversations_id_machine_id_key unique (id, machine_id);

alter table turns drop constraint turns_machine_id_fkey;
alter table turns add constraint turns_on_its_conversations_machine
  foreign key (conversation_id, machine_id) references conversations (id, machine_id);

-- migrate:down

alter table turns drop constraint turns_on_its_conversations_machine;
alter table turns add constraint turns_machine_id_fkey foreign key (machine_id) references machines(id);
alter table conversations drop constraint conversations_id_machine_id_key;
