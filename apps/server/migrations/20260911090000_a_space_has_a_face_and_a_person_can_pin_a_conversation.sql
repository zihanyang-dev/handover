-- migrate:up

alter table spaces
  add column emoji text not null default '🏠',
  add constraint spaces_emoji_is_bounded check (char_length(emoji) between 1 and 32);

create table conversation_pins (
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  pinned_at timestamptz not null default clock_timestamp(),
  primary key (user_id, conversation_id)
);

create index conversation_pins_by_person
  on conversation_pins (user_id, pinned_at desc);

-- migrate:down

drop table conversation_pins;
alter table spaces drop column emoji;
