-- What became of the letter a code was minted for.
--
-- The row is committed before the letter is handed to anyone, and it has to be: a letter sent for
-- a code that then rolled back cannot be recalled, while a code with no letter can be sent again.
-- But nothing was written down afterwards, so three different situations looked identical to the
-- next request carrying the same key — and all three were answered "a code is on its way".
--
--   sent      it is in that inbox. Asking again must not put a second one there.
--   refused   no letter can reach that address. Saying "on its way" is a person waiting forever.
--   unknown   their side broke after taking it. It may be in the inbox; nobody can say.
--   null      no attempt has finished. Either one is in flight, or the process died mid-send —
--             and nobody, including us, knows the code, because it only ever existed in memory.
--
-- The last one is the one this column makes recoverable: a row that has had longer than the
-- mailer's own patience and still says nothing is a row whose letter will never exist, so the
-- next request mints a fresh code rather than pointing at a dead one.

-- migrate:up

alter table email_codes add column delivery text
    check (delivery in ('sent', 'refused', 'unknown'));

-- migrate:down

alter table email_codes drop column delivery;
