-- Who asked for a code, in the one form it is kept in.
--
-- The wait between codes is per address, and somebody rotating addresses walks straight past it.
-- Every letter that gets sent that way costs money and spends the sending domain's reputation,
-- and a domain marked as a source of spam takes months to recover.
--
-- A hash, not an address. What is wanted is "the same caller as before" and nothing else; a column
-- of addresses would be a log of where people sign in from, kept for as long as the rows live.
--
-- Null for anything issued before this existed, and for a deployment that cannot tell — those rows
-- simply do not count towards anybody.

-- migrate:up

alter table email_codes add column asked_by text;

create index email_codes_asked_by on email_codes (asked_by, created_at)
    where asked_by is not null;

-- migrate:down

drop index email_codes_asked_by;
alter table email_codes drop column asked_by;
