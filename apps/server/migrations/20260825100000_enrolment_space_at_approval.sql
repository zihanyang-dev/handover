-- migrate:up

-- Which Space a machine joins is decided by whoever approves it, not by the machine.
--
-- A machine naming a Space meant an unauthenticated caller could tell an existing slug from a
-- missing one by the answer it got, which is the probe `prd.md` promises the address bar is not.
-- It also asked the wrong party: the machine has no standing to choose, and the person approving
-- has nothing but standing.
--
-- Still set at creation on the key path, where a person generating a key in a Space has already
-- chosen by being there.
alter table enrolments alter column space_id drop not null;

-- Approved and homeless cannot both be true: saying yes is where the Space comes from.
alter table enrolments add constraint enrolments_approved_into_a_space
  check (approved_at is null or space_id is not null);

-- migrate:down

alter table enrolments drop constraint enrolments_approved_into_a_space;
alter table enrolments alter column space_id set not null;
