-- A machine's owner is written twice: `enrolments.approved_by` says who said yes, and
-- `machines.owner_user_id` is that answer copied across when the machine collected its credential.
--
-- The copy stays, for the same reason `turns.machine_id` does: it carries `machines_of_owner`, and
-- every question about a machine goes through it — which Spaces can reach it, whose it is on the
-- page, and who is allowed to disconnect it. Read through `enrolled_from` instead, all three join
-- a second table for a fact that never changes.
--
-- What is not acceptable is that they could disagree. Nothing changes ownership today, so the two
-- can only diverge through a data repair or a later migration correcting one of them — and then
-- the approval says one person while reachability, the name on the row and the Disconnect button
-- all say another, with the database perfectly happy. `code-style.md` 9: a late writer has to fail
-- in SQL.

-- migrate:up

alter table enrolments add constraint enrolments_id_approved_by_key unique (id, approved_by);

alter table machines drop constraint machines_enrolled_from_fkey;
alter table machines add constraint machines_owned_by_whoever_approved_it
  foreign key (enrolled_from, owner_user_id) references enrolments (id, approved_by);

-- migrate:down

alter table machines drop constraint machines_owned_by_whoever_approved_it;
alter table machines add constraint machines_enrolled_from_fkey
  foreign key (enrolled_from) references enrolments(id);
alter table enrolments drop constraint enrolments_id_approved_by_key;
