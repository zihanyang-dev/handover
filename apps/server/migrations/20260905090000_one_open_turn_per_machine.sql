-- A machine runs exactly one thing at a time, and the database is what says so.
--
-- `takeOne` asks whether the machine has an open turn and inserts in the same statement, which
-- looks atomic and is not: under read committed each instance evaluates that `not exists` against
-- its own snapshot, and neither sees the other's uncommitted insert. Two instances polling for one
-- machine therefore claim *different* conversations — no primary key in common, both succeed, and
-- two agents run in the same directory overwriting each other's files. `prd.md` 04 ⑫ promises
-- exactly the opposite, and it is also the only limit on how much runs at once anywhere.
--
-- A test cannot close this: both statements have to start before either commits, so a passing run
-- proves only that the timing did not line up. `code-style.md` 9 — a late writer has to fail in
-- SQL. `takeOne` already inserts with `on conflict do nothing`, so the loser now claims nothing
-- and is told there is no work, which is the truth.
--
-- It replaces the plain index of the same shape: unique is strictly stronger, and answers the same
-- question ("is this machine busy") through the same partial scan.

-- migrate:up

-- Anything already holding two is from exactly the race this prevents, and which of them a
-- process is really running is unknowable from here. The oldest claim stays; the rest are closed,
-- the way a restart closes what it finds. No transcript line is written for them: a migration that
-- writes into conversations is a migration that can be read as an agent, and the next report from
-- that machine says what really happened anyway.
with extra as (
  select conversation_id, after_seq,
         row_number() over (partition by machine_id order by claimed_at) as nth
    from turns
   where ended_at is null
)
update turns t set ended_at = now()
  from extra
 where extra.nth > 1
   and t.conversation_id = extra.conversation_id
   and t.after_seq = extra.after_seq;

drop index turns_open_on_machine;
create unique index turns_one_open_per_machine on turns (machine_id) where ended_at is null;

-- migrate:down

drop index turns_one_open_per_machine;
create index turns_open_on_machine on turns (machine_id) where ended_at is null;
