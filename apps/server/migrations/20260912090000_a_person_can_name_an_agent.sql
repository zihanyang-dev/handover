-- migrate:up

-- A discovered agent and the name its owner chose have different lifetimes. Discovery replaces the
-- whole reported set; a temporary absence must not erase a person's choice.
create table agent_names (
  machine_id uuid        not null references machines (id) on delete cascade,
  kind       text        not null constraint agent_names_kind_check
                         check (kind in ('claude-code', 'codex')),
  name       text        not null check (
                         name = btrim(name)
                         and char_length(name) between 1 and 48
                       ),
  named_at   timestamptz not null default clock_timestamp(),
  primary key (machine_id, kind)
);

-- migrate:down

drop table agent_names;
