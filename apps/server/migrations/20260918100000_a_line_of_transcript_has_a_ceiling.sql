-- The one column with no ceiling, in the table that grows for ever.
--
-- Everything around it had one: an output is capped at 64 KB, a goal at 2000 characters, a machine
-- name at 100. A transcript line — the thing written on every turn, kept for the life of the
-- conversation — could be any size at all, and the only thing holding it down was that the machine
-- at the other end chose to send pieces.
--
-- The live stream, which is thrown away a second later, was checked. This, which is kept, was not.
--
-- 128 KB rather than the 64 KB the wire now allows for what is said: the row is that plus its
-- JSON, and a ceiling that sits exactly on the wire's is one that a comma turns into a refusal.
-- The largest line anywhere today is 8.5 KB.

-- migrate:up

alter table messages
  add constraint messages_content_size check (octet_length(content::text) <= 131072);

-- migrate:down

alter table messages drop constraint messages_content_size;
