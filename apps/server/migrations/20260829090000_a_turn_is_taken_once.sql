-- One turn: one question, one machine, one outcome.
--
-- Until now "has anybody started this" was guessed from the transcript — a question whose last
-- word was still the person's was assumed to be waiting. Two things went wrong with that. Two
-- processes holding the same machine credential both saw the same question and both ran it, in the
-- same directory. And an agent that started and then died before writing its first line left a
-- question that still looked untouched, so it was handed out again — running whatever it had
-- already done a second time, which is exactly what `unknown` exists to prevent.
--
-- Taking a turn is now an insert. Two machines racing both run it and the primary key picks one;
-- the loser is told nothing is waiting, which is true. Nothing is decided in TypeScript, and
-- nothing is inferred from what was said.
--
-- The transcript stays the record of what happened. This is the record of what was run — the two
-- answer different questions, and merging them is what made "who is working" a guess.

-- migrate:up

create table turns (
    conversation_id uuid not null references conversations (id) on delete cascade,

    -- The question this turn answers, by its place in the conversation. A question is a message,
    -- so its `seq` names it — and `messages_in_order` already says no two share one.
    asked_seq integer not null,

    -- Which machine took it. Not "which machine the conversation is pinned to": that one can be
    -- removed and replaced, and this says who was actually running.
    machine_id uuid not null references machines (id),

    claimed_at timestamptz not null default clock_timestamp(),

    -- When the machine said how it went. Null is a turn still running — or one nobody has been
    -- able to say anything about yet, which is the same thing to everyone but the machine.
    ended_at timestamptz,

    -- One winner per question, decided here rather than by whoever asked first.
    primary key (conversation_id, asked_seq),

    foreign key (conversation_id, asked_seq)
        references messages (conversation_id, seq) on delete cascade
);

-- What a machine is running right now, and what it left open when it restarted.
create index turns_open_on_machine on turns (machine_id) where ended_at is null;

-- migrate:down

drop table turns;
