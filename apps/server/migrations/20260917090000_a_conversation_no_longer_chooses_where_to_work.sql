-- The question this column answered is no longer asked.
--
-- It held a directory somebody named when they opened a conversation, so an agent could work in
-- their own checkout and read changes they had not committed. That is a developer's want, and it
-- was put to everybody, every time they started a chat — including the people this product is
-- also for, who are not holding a checkout at all and for whom the question has no answer.
--
-- Nothing is lost that anybody had: the browser never sent it. Every conversation has always
-- worked in a folder of its own, which is what the column's own default meant.
--
-- `machines.connected_in` stays. It arrived to feed this choice, but it earns its place twice
-- over now: reconnecting a machine lists the ones already here, and the directory each was
-- connected from is how a person tells them apart.

-- migrate:up

alter table conversations drop column works_in;

-- migrate:down

alter table conversations
  add column works_in text
  constraint conversations_works_in_check check (
    works_in = btrim(works_in) and char_length(works_in) between 1 and 512
  );
