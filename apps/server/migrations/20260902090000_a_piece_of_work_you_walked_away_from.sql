-- A piece of work somebody handed over and walked away from.
--
-- One row per hand-over, not per conversation: a conversation can be handed over, finished, chatted
-- in some more, and handed over again — that is two pieces of work with two beginnings and two
-- endings, and one of them remembers how the other went.
--
-- `state` is the only thing here that nothing else can say: it is the agent's own declaration that
-- it stopped, and why. Everything a person sees beyond these four values is derived — that its
-- machine is not here, that it is waiting on the work it handed off — for the same reason a
-- conversation's three states are derived: a machine that is killed never writes that it stopped.

-- migrate:up

-- A turn no longer has to be answering a question. Under this name the column claimed two things:
-- where the turn starts, and that a person asked for it. Only the first is still true.
alter table turns rename column asked_seq to after_seq;

create table tasks (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations(id) on delete cascade,
    -- The piece of work that opened this one. Null is "a person did", and that is what decides
    -- whose Inbox its questions land in.
    parent_id uuid references tasks(id),
    owner_user_id uuid not null references users(id),
    -- What it is for, in the agent's own restatement, which a person approved before any of this
    -- began. It is the identity of the work: a list shows it, an Inbox shows it, and it is what
    -- somebody coming back three days later reads first.
    goal text not null check (btrim(goal) <> '' and octet_length(goal) <= 2000),
    state text not null check (state in ('working', 'wait', 'sleep', 'done')),
    sleep_until timestamptz,
    created_at timestamptz not null default now(),
    ended_at timestamptz,
    -- The pairs, mechanised rather than remembered: ended exactly when done, and a moment to wake
    -- at exactly when asleep.
    check ((ended_at is null) = (state <> 'done')),
    check ((sleep_until is null) = (state <> 'sleep'))
);

-- One at a time. A conversation has one agent, one machine and one thread — two open pieces of
-- work in it and nothing could say which one a turn was for.
create unique index tasks_one_open_per_conversation on tasks (conversation_id)
    where ended_at is null;

-- The waker asks "who is due" across every Space every few seconds, and a timestamp buried in a
-- message's JSON cannot answer that. This index is the whole reason `sleep_until` is a column.
create index tasks_due on tasks (sleep_until) where state = 'sleep';

-- The Inbox: everything waiting on one person, across every Space they are in.
create index tasks_waiting_on_owner on tasks (owner_user_id)
    where state = 'wait' and parent_id is null;

-- Whether a piece of work is waiting on what it handed off, which is counted rather than stored.
create index tasks_open_children on tasks (parent_id) where ended_at is null;

-- Something the agent wrote on purpose, as opposed to a file it happened to touch on the way.
--
-- The title is the identity, so writing under the same one again revises it: a three-day report
-- gets its opening on the first day and its conclusion on the third, and it stays one document.
create table outputs (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references tasks(id) on delete cascade,
    title text not null check (btrim(title) <> '' and octet_length(title) <= 200),
    body text not null check (btrim(body) <> '' and octet_length(body) <= 65536),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (task_id, title)
);

-- migrate:down

drop table outputs;
drop table tasks;
alter table turns rename column after_seq to asked_seq;
