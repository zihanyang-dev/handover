-- Which person said a line, not just that a person did.
--
-- `role` has always been the *kind* of author — `transcript.ts` calls the four of them person,
-- agent, tool and nobody — and while a Space held one person that was enough: the only person who
-- could have said it was you. `05` put a second person in the room and the same column now says
-- "somebody" about a line that has to be read as "Kai".
--
-- Nullable from the first day, and that is a borrowed lesson rather than caution. Multica's
-- comment table made its author NOT NULL and had to add a zero-UUID sentinel the moment the
-- platform itself needed to post a row belonging to nobody — a false value that every reader has
-- to know is false. Three of our four kinds of line have no person behind them, so the column is
-- empty for them and says so.
--
-- Rows written before this cannot be given an author. Nothing knows who spoke, and guessing from
-- the conversation is exactly what turned commit attribution into a trust problem elsewhere. They
-- stay without one, and the screen says so — `prd.md` 06 ⑥.

-- migrate:up

alter table messages add column said_by uuid references users (id);

-- `not valid` is the whole shape of this slice: the rows already here are left alone, and every
-- row written from now on is checked. It is not "off" — an insert or an update that breaks it
-- still fails; Postgres simply does not scan backwards over lines nobody can name.
alter table messages add constraint messages_a_person_has_a_name
  check ((role = 'user') = (said_by is not null)) not valid;

-- Every question about a person's lines is asked within one conversation.
create index messages_said_by on messages (said_by) where said_by is not null;

-- migrate:down

drop index messages_said_by;
alter table messages drop constraint messages_a_person_has_a_name;
alter table messages drop column said_by;
