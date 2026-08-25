-- An idempotency key is the caller's own string, so it only means anything alongside who sent it
-- and what they asked for.
--
-- Unique on the key alone, one caller's key collides with another's: making a Space with a reused
-- key handed back the id, address and name of a private Space the caller is not a member of, and a
-- code asked for with a reused key came back saying a letter was on its way to an inbox nothing
-- was ever sent to.
--
-- What makes two requests the same request is stated here rather than in a query, because a query
-- that forgets is a query that reads somebody else's row.

-- migrate:up

alter table memberships drop constraint memberships_request_key_key;
alter table memberships add constraint memberships_asked_once unique (user_id, request_key);

-- The address and the purpose, because those are what a code is for. Two different letters cannot
-- be the same request however the caller names them.
alter table email_codes drop constraint email_codes_request_key_key;
alter table email_codes add constraint email_codes_asked_once unique (request_key, email, purpose);

-- migrate:down

alter table memberships drop constraint memberships_asked_once;
alter table memberships add constraint memberships_request_key_key unique (request_key);

alter table email_codes drop constraint email_codes_asked_once;
alter table email_codes add constraint email_codes_request_key_key unique (request_key);
