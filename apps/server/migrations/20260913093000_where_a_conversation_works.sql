-- The two things this deployment knows about where work happens, and it decides neither of them.
--
-- Where a conversation's agent works is the machine's to compute — a folder of its own, named
-- after the conversation — which is what leaves room for a sandbox to answer the same question
-- with a root of its own. Nothing here says where anything is.

-- migrate:up

-- What a person chose, when they chose. Null — nearly always — means the machine picks. Stored
-- because they said it, not because we decided it.
alter table conversations
  add column works_in text
  constraint conversations_works_in_check check (
    works_in = btrim(works_in) and char_length(works_in) between 1 and 512
  );

-- What the machine says about itself: the directory `handover connect` was run in.
--
-- It never had to be here, because a machine ran one thing and it ran there. Now that a
-- conversation can work somewhere of its own, "in my project" is a choice somebody makes when
-- they open one — and a screen cannot offer a directory it has never been told.
--
-- Replaced on every report, exactly like `version`: a service can be moved, and the answer has to
-- be about the process running now. Null when the machine is a build too old to say.
alter table machines add column connected_in text;

-- migrate:down

alter table machines drop column connected_in;
alter table conversations drop column works_in;
