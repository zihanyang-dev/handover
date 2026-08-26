-- A machine belongs to a person, not to a Space.
--
-- It is somebody's laptop. A laptop belongs to whoever owns it, and that person is in as many
-- Spaces as they are in — so tying the machine to one of them puts the relationship the wrong way
-- round, and makes "I want to use my own laptop from my other Space" a second enrolment.
--
-- Which Spaces it can be reached from is therefore not stored: it is every Space its owner is a
-- member of, joined through `memberships`. Stored, that list would be a second copy of who is in
-- what, and the day it disagreed nobody would find out.
--
-- The credential does not change. It is still a machine's own, able only to do machine things —
-- report in, write into a conversation it was given, say how its work is going. What moved is who
-- it belongs to, not what it can do.

-- migrate:up

alter table machines add column owner_user_id uuid references users(id);

-- Whoever said yes to it. `enrolments.approved_by` has been recorded since the first day, so
-- nothing here is guessed: every machine that exists was let in by somebody.
update machines
   set owner_user_id = enrolments.approved_by
  from enrolments
 where enrolments.id = machines.enrolled_from;

alter table machines alter column owner_user_id set not null;

drop index machines_in_space;
alter table machines drop constraint machines_space_id_fkey;
alter table machines drop column space_id;

create index machines_of_owner on machines (owner_user_id) where removed_at is null;

-- An approved enrolment names a person now, not a Space. `approved_by` already said who.
alter table enrolments drop constraint enrolments_approved_into_a_space;
alter table enrolments drop constraint enrolments_space_id_fkey;
alter table enrolments drop column space_id;

-- migrate:down

alter table enrolments add column space_id uuid references spaces(id);
alter table machines add column space_id uuid references spaces(id);
drop index machines_of_owner;
alter table machines drop column owner_user_id;
create index machines_in_space on machines (space_id) where removed_at is null;
