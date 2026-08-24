-- migrate:up

-- One attempt to bring a machine into a Space.
--
-- Both ways in are this row; the difference is only whether it was already approved when it was
-- written. A person at a browser writes an approved one and pastes its secret onto a server; a
-- machine writes an unapproved one and waits for somebody to approve it. An auth key is not a
-- second mechanism — it is an enrolment that arrived approved.
create table enrolments (
  id           uuid        primary key default gen_random_uuid(),
  space_id     uuid        not null references spaces (id),
  machine_name text        not null,

  -- What the machine shows to collect its credential. Only the hash is here, as everywhere.
  secret_hash  text        not null unique,

  -- What a person reads off one screen and types into another. Absent on the key path: nobody
  -- reads anything there, and a code nobody will type is a code that can only leak.
  user_code    text        unique,

  approved_by  uuid        references users (id),
  approved_at  timestamptz,
  refused_at   timestamptz,
  claimed_at   timestamptz,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),

  -- Approved by nobody is a row that lost track of who said yes.
  constraint enrolments_approved_together
    check ((approved_at is null) = (approved_by is null)),

  -- Refused and approved are both terminal and mean opposite things. A row that is somehow both
  -- would let a refusal be walked back by whoever asks second.
  constraint enrolments_not_both_answers
    check (refused_at is null or approved_at is null),

  -- Nothing is collected before it is approved. The claim path checks this too; the constraint is
  -- what makes a bug there fail in SQL rather than hand out a credential.
  constraint enrolments_claimed_after_approval
    check (claimed_at is null or approved_at is not null)
);

-- Somebody typing a code has to reach the one enrolment that is still waiting. Spent codes stay
-- in the table for the answer they give ("that one is used"), so the index only holds the live
-- ones and a code becomes reusable once its enrolment is over.
create unique index enrolments_waiting_code
  on enrolments (user_code) where claimed_at is null and refused_at is null;

-- A machine that got in.
--
-- `name` is what a person sees, nothing more: two machines may share one, and neither is harmed.
-- Identity is the row.
create table machines (
  id            uuid        primary key default gen_random_uuid(),
  space_id      uuid        not null references spaces (id),
  name          text        not null,
  token_hash    text        not null unique,
  enrolled_from uuid        not null references enrolments (id),

  -- Presence is read, never stored: a process that is killed never writes `offline`, and the row
  -- would say a dead machine is here forever. `left_at` is the exception because it is not
  -- derivable — a timestamp cannot say whether the silence after it was chosen.
  last_seen_at  timestamptz not null default clock_timestamp(),
  left_at       timestamptz,

  removed_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index machines_in_space on machines (space_id) where removed_at is null;

-- What a machine found on itself, as of its last check-in.
--
-- No status column: an agent is available exactly when its machine is here, and a second place
-- to say so is a second place to be wrong.
create table agents (
  machine_id uuid        not null references machines (id) on delete cascade,
  kind       text        not null check (kind in ('claude-code', 'codex', 'cursor-agent')),
  version    text        not null,
  found_at   timestamptz not null default clock_timestamp(),
  primary key (machine_id, kind)
);

-- migrate:down

drop table agents;
drop table machines;
drop table enrolments;
