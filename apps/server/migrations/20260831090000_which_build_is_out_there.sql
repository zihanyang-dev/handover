-- Which build of the CLI a machine is running.
--
-- The agents' versions were reported from the first day; the machine's own never was. The question
-- it answers is the first one asked about a machine behaving strangely, and it can only be asked of
-- a machine that is far away — the one nobody can run `handover version` on.
--
-- Null is "it did not say", which is a real state and not a missing value: a build older than this
-- column has no way to know it should. It is not defaulted for the same reason — a default would
-- put a version we invented next to machines that never reported one.

-- migrate:up

alter table machines add column version text;

-- migrate:down

alter table machines drop column version;
