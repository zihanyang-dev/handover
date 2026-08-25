-- migrate:up

-- One conversation with one agent on one machine.
--
-- Pinned at creation and never moved: an agent's memory of what was said lives in that agent, on
-- that machine, so a conversation that changed either would be pretending two agents are one.
create table conversations (
    id uuid primary key default gen_random_uuid(),
    space_id uuid not null references spaces (id),
    machine_id uuid not null references machines (id),
    -- No check on which agent. A conversation can only be opened against one the machine
    -- actually reported having, which is a stronger thing to know than a list written here, and
    -- that list already exists twice — in `agents_kind_check` and in `agent-kind.ts`.
    agent_kind text not null,

    -- What the agent calls this conversation on its side. Absent until it says so, and unchanged
    -- when a later turn picks it up again. It is also how the machine finds the agent's own record
    -- of the work, which is the only evidence left after a crash.
    agent_session_id text,

    created_at timestamptz not null default now()
);

create index conversations_in_space on conversations (
    space_id, created_at desc
);

-- What a machine is being asked to do next: the oldest conversation whose last word is a person's.
create index conversations_on_machine on conversations (machine_id);

-- One thing said or done, in our words rather than any agent's.
--
-- Written once and never revised. Everything with a lifetime — a command that is still running, a
-- sentence still arriving — is live on the wire only; the row appears when it is settled. Revising
-- rows instead would mean an update per streamed fragment, and Postgres keeps every version of an
-- updated row until it is vacuumed.
create table messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations (
        id
    ) on delete cascade,

    -- Order within the conversation. Assigned here, under the conversation's lock, so that no writer
    -- has to guess where it lands.
    seq integer not null,

    -- What this message is, decided by whoever writes it: `t4/said`, `t4/tool/toolu_01…`. Two
    -- processes racing over one turn write the same names, so the loser fails here rather than
    -- doubling the transcript.
    key text not null,

    -- Who this is from. `tool` is neither the person nor the agent — it is what the world answered.
    -- `activity` is everything that is neither speech nor a tool: how a turn ended, that the agent
    -- no longer remembers. New kinds of activity are a value, not a migration.
    role text not null check (
        role in ('user', 'assistant', 'tool', 'activity')
    ),

    content jsonb not null,
    created_at timestamptz not null default clock_timestamp(),

    constraint messages_in_order unique (conversation_id, seq),
    constraint messages_said_once unique (conversation_id, key)
);

-- migrate:down

drop table messages;
drop table conversations;
