-- migrate:up

-- A key is generated before anybody knows which machine will use it.
--
-- On the code path the name is shown to whoever approves, so it is settled before the machine is
-- let in and it is what they agreed to. On the key path there is nothing to show and nobody to
-- show it to: the name arrives with the machine that collects it, because that machine is the
-- only party that knows it.
alter table enrolments alter column machine_name drop not null;

-- migrate:down

alter table enrolments alter column machine_name set not null;
