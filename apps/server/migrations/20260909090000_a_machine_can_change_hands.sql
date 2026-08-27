-- A machine's owner can move; who approved it cannot.
--
-- `20260906` pinned `machines.owner_user_id` to `enrolments.approved_by` with a composite foreign
-- key, and it was right for as long as ownership never moved: the two were one fact written twice,
-- and the only thing they could do differently was disagree.
--
-- A Space with two people in it ends that. The two columns now answer different questions —
-- `approved_by` is who said yes, once, and `owner_user_id` is whose it is now — so a machine handed
-- to somebody else is not an inconsistency, it is the point.
--
-- What stays true, and what this keeps, is the narrower rule the old one was really protecting:
-- **a machine cannot be born under the wrong person.** At the moment it collects its credential its
-- owner is whoever approved it, and only afterwards may that move. So the constraint changes shape
-- rather than going away — from a foreign key to a trigger that fires on insert — because
-- `code-style.md` 9 has not changed either: a late writer has to fail in SQL, not in a comment.
--
-- `enrolments.approved_by` is left exactly as it is. It is read in one place — seeding a new
-- machine's owner — and is otherwise history, which `prd.md` 05 ⑦ promises never to rewrite.

-- migrate:up

create function a_machine_is_born_to_its_approver() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from enrolments
     where enrolments.id = new.enrolled_from
       and enrolments.approved_by = new.owner_user_id
  ) then
    raise exception 'a machine belongs to whoever approved it'
      using constraint = 'machines_born_to_their_approver';
  end if;

  return null;
end;
$$;

alter table machines drop constraint machines_owned_by_whoever_approved_it;

-- `owner_user_id` already references `users` on its own, from `20260903`. What the composite key
-- added was the second column, and this puts back the plain one it replaced.
alter table machines add constraint machines_enrolled_from_fkey
  foreign key (enrolled_from) references enrolments (id);

create constraint trigger machines_born_to_their_approver
  after insert on machines
  deferrable initially deferred
  for each row execute function a_machine_is_born_to_its_approver();

-- migrate:down

drop trigger machines_born_to_their_approver on machines;
drop function a_machine_is_born_to_its_approver();

alter table machines drop constraint machines_enrolled_from_fkey;

alter table machines add constraint machines_owned_by_whoever_approved_it
  foreign key (enrolled_from, owner_user_id) references enrolments (id, approved_by);
