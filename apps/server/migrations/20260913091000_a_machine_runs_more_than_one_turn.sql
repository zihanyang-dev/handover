-- `04` ⑫ said a machine does exactly one thing at a time, and this index was how it said it.
--
-- The reason written into that migration was not parallelism — it was that "two agents run in the
-- same directory overwriting each other's files", and the directory was one because a machine had
-- one: whatever `handover connect` was run in. `07` gives every conversation its own, so the
-- reason is gone.
--
-- What the index was standing in for is now counted, per agent rather than per machine, under an
-- advisory lock on the machine: the count and the claim in one transaction. A unique index can
-- say "at most one" and there is no index that says "at most n".

-- migrate:up

drop index turns_one_open_per_machine;
-- Every read of this table is still "the open turns on this machine". There are now several of
-- them rather than at most one.
create index turns_open_on_machine on turns (machine_id) where ended_at is null;

-- migrate:down

drop index turns_open_on_machine;

-- Going back means a machine may hold one open turn again, and by then several of them are open
-- and every one is legitimate. The oldest on each machine stays and the rest are closed.
--
-- This does not preserve meaning and nothing can: the agent processes go on running, and the
-- conversations they belong to are left with a ledger that says the turn ended and a transcript
-- that does not say how. It is a development affordance for a schema that has never shipped, not
-- a rollback anybody should reach for with work in flight. Deliberately no transcript line —
-- `20260905090000` settled that a migration writing into conversations is one that can be read
-- as an agent.
update turns t set ended_at = now()
 where t.ended_at is null
   and exists (
     select 1 from turns older
      where older.machine_id = t.machine_id
        and older.ended_at is null
        and (older.claimed_at, older.conversation_id) < (t.claimed_at, t.conversation_id)
   );
create unique index turns_one_open_per_machine on turns (machine_id) where ended_at is null;
