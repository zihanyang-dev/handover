-- A lost local credential does not have to create a second machine identity.
-- The person makes the replacement choice while approving. A name never does:
-- names are non-unique; an automatic match could disconnect another machine.

-- migrate:up

alter table enrolments
add column replaces_machine_id uuid references machines (id),
add constraint enrolments_replacement_is_approved
check (replaces_machine_id is null or approved_at is not null);

-- Two terminals may ask to reconnect the same identity. Until the winner collects, a second
-- approval would otherwise rotate the token again and make the first terminal's success a lie.
create unique index enrolments_one_pending_replacement
on enrolments (replaces_machine_id)
where replaces_machine_id is not null and claimed_at is null;

-- migrate:down

drop index enrolments_one_pending_replacement;
alter table enrolments drop column replaces_machine_id;
