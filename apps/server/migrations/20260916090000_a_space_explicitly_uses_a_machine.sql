-- A membership says who is in a Space. It does not silently grant that Space a person's computer.
-- One row is the explicit, revocable answer to whether this Space may use this machine.

-- migrate:up

alter table enrolments
add column approved_space_id uuid references spaces (id),
add constraint enrolments_space_is_approved
check (approved_space_id is null or approved_at is not null);

create table space_machines (
  space_id uuid not null references spaces (id),
  machine_id uuid not null references machines (id),
  added_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (space_id, machine_id)
);

-- Keep every historical conversation referentially valid, even when its machine owner has since
-- left. These rows are history only until the active-membership backfill below clears removed_at.
insert into space_machines (space_id, machine_id, added_by, removed_at)
select distinct conversations.space_id, conversations.machine_id, machines.owner_user_id, now()
from conversations
join machines on machines.id = conversations.machine_id
on conflict (space_id, machine_id) do nothing;

-- Preserve what every current Space can reach at deployment. Future memberships do not run this:
-- after the migration, adding a machine is its own explicit action.
insert into space_machines (space_id, machine_id, added_by)
select memberships.space_id, machines.id, machines.owner_user_id
from machines
join memberships on memberships.user_id = machines.owner_user_id
where machines.removed_at is null and memberships.revoked_at is null
on conflict (space_id, machine_id) do update set removed_at = null;

alter table conversations
add constraint conversations_machine_is_in_space
foreign key (space_id, machine_id) references space_machines (space_id, machine_id);

-- migrate:down

alter table conversations drop constraint conversations_machine_is_in_space;
drop table space_machines;
alter table enrolments drop column approved_space_id;
