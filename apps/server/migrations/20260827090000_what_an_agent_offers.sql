-- What an agent lets a person choose, as that agent reported it.
--
-- On the `agents` row because that is exactly what it is a fact about: this machine, this agent,
-- this version. A model list is a thing a version can do, so it travels with the version and not
-- with the clock — a machine asks its agent again when the version changes, and at no other time,
-- because asking costs starting the agent up.
--
-- Null and `[]` are different answers. Null is nobody has said (an older CLI, or a version we have
-- not been told about yet); `[]` is the agent was asked and offers nothing to choose. A page shows
-- no control either way, but only one of the two is worth asking again about.
--
-- No shape enforced here. It is jsonb for the same reason a message's content is: this is written
-- and read by our own code at both ends, and the check that matters happens where it is parsed.

-- migrate:up

alter table agents add column models jsonb;

-- migrate:down

alter table agents drop column models;
