-- The screen this column was kept for was never built.
--
-- It arrived to feed the choice `20260917090000` removed, and that migration kept it on a second
-- reason: reconnecting a machine lists the ones already here, and the directory each was connected
-- from is how a person tells them apart. That screen does not read it. Nothing reads it — the
-- machine reported it, the contract carried it, the browser put it in a view model, and no pixel
-- ever showed it.
--
-- A justification a reader can check against the code, and find nothing there, is worse than no
-- column at all: it is a promise the product does not keep, written where somebody will believe
-- it. If the reconnect screen ever wants this, it can ask for it then, and mean it.

-- migrate:up

alter table machines drop column connected_in;

-- migrate:down

alter table machines add column connected_in text;
