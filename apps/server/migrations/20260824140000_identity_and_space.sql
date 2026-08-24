-- migrate:up

-- An account has nothing in it. It is not an address and it is not somebody's account at a
-- provider: it is an id, and the things that open it hang off it.
create table users (
  id           uuid        primary key default gen_random_uuid(),
  display_name text        not null,
  created_at   timestamptz not null default now()
);

-- Everything that opens this account, one row each, because they are one concept. An address
-- proved by a code and a provider account proved by a handshake open the same door and carry the
-- same weight; another kind later (a phone number) is another `kind`, not another table.
--
-- `subject` is normalized per kind, and the two rules are opposites: an address is lowercased,
-- because otherwise one person becomes two accounts, and a provider's id is copied exactly,
-- because it is theirs and not ours to reshape.
create table credentials (
  user_id     uuid        not null references users (id),
  kind        text        not null check (kind in ('email', 'google', 'github')),
  subject     text        not null,
  -- clock_timestamp(), not now(): now() is the transaction's start time, so an address and the
  -- provider key proved with it would be stamped identically and "the address this account
  -- started with" would come down to how the rows happened to sort.
  verified_at timestamptz not null default clock_timestamp(),
  primary key (user_id, kind, subject),
  -- One credential opens one account. This is what the whole merge rule stands on: an address
  -- held by two accounts leaves "which account does this address reach" with no answer.
  unique (kind, subject)
);

-- Addresses are held many per account; a provider account is held one per account, which is what
-- the panel shows when it says Google is either ready or connectable.
create unique index credentials_one_provider_account_each
  on credentials (user_id, kind) where kind <> 'email';

-- A code we emailed, and what became of it. Two different reasons stop one working, and the
-- person reading the failure needs them apart: "already used" may mean someone else signed in.
--
-- `purpose` is what the letter is for, not how strong it is. A code sent to sign in cannot be
-- handed to the endpoint that adds an address, and the other way round.
create table email_codes (
  id            uuid        primary key default gen_random_uuid(),
  email         text        not null,
  purpose       text        not null check (purpose in ('sign-in', 'attach')),
  code_hash     text        not null,
  request_key   text        not null unique,
  attempts      integer     not null default 0,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  closed_at     timestamptz,
  closed_reason text                 check (closed_reason in ('consumed', 'superseded')),
  constraint email_codes_closed_together
    check ((closed_at is null) = (closed_reason is null))
);

-- One live code per address per purpose, so the newest is the only one that works, and asking to
-- add an address does not quietly kill a sign-in somebody is halfway through.
-- The predicate cannot also test expires_at: Postgres requires index predicates to be immutable
-- and now() is not. Expiry is decided on read instead.
create unique index email_codes_live
  on email_codes (email, purpose) where closed_at is null;

-- Written once, read on every request. Expiry and revocation are decided by the read, so a
-- cleanup job that never runs costs table size and never leaves a dead session usable.
create table browser_sessions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users (id),
  token_hash text        not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table spaces (
  id           uuid        primary key default gen_random_uuid(),
  display_name text        not null,
  slug         text        not null unique,
  created_at   timestamptz not null default now()
);

-- request_key carries the idempotency of creating a Space, and it sits here because the
-- membership is what makes the Space reachable by the person who asked for it.
create table memberships (
  space_id    uuid        not null references spaces (id),
  user_id     uuid        not null references users (id),
  request_key text        not null unique,
  created_at  timestamptz not null default now(),
  primary key (space_id, user_id)
);

-- migrate:down

drop table memberships;
drop table spaces;
drop table browser_sessions;
drop table email_codes;
drop table credentials;
drop table users;
