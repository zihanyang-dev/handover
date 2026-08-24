-- migrate:up

create table users (
  id             uuid        primary key default gen_random_uuid(),
  verified_email text        not null unique,
  display_name   text        not null,
  created_at     timestamptz not null default now()
);

-- The provider's stable subject, never their email: the user may change it on that side and the
-- link has to survive. One provider account reaches one user, and one user holds one account
-- per provider, which is what the sign-in screen shows.
create table sign_in_methods (
  user_id   uuid        not null references users (id),
  kind      text        not null check (kind in ('google', 'github')),
  subject   text        not null,
  linked_at timestamptz not null default now(),
  primary key (user_id, kind),
  unique (kind, subject)
);

-- A challenge stops being usable for two different reasons, and the person reading the failure
-- needs them apart: "already used" may mean someone else signed in with it.
create table email_challenges (
  id            uuid        primary key default gen_random_uuid(),
  email         text        not null,
  code_hash     text        not null,
  request_key   text        not null unique,
  attempts      integer     not null default 0,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  closed_at     timestamptz,
  closed_reason text                 check (closed_reason in ('consumed', 'superseded')),
  constraint email_challenges_closed_together
    check ((closed_at is null) = (closed_reason is null))
);

-- One open challenge per address, so the newest code is the only one that works.
-- The predicate cannot also test expires_at: Postgres requires index predicates to be
-- immutable and now() is not. Expiry is decided on read instead.
create unique index email_challenges_open on email_challenges (email) where closed_at is null;

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
drop table email_challenges;
drop table sign_in_methods;
drop table users;
