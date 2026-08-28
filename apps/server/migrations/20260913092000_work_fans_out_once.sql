-- Two levels of work, and the database is what says so.
--
-- `prd.md` 07 ⑤: only what a person owns may hand work out. Refusing it in `handOffTo` covers
-- what this build writes and nothing else — rows written before this were allowed any depth, and
-- `takeBack` no longer walks a tree, so a grandchild left behind is work still changing files
-- after the person who could stop it already took the parent back.

-- migrate:up

-- Flattened rather than ended. Every one of these is work somebody asked for; made a direct child
-- of the root it belonged to, it keeps running and take-back reaches it. Ending them would stop
-- work nobody asked to stop, and no migration can stop the process it belongs to. Adding the key
-- without this would fail on any database holding a deep tree, with a message about a constraint
-- rather than about the work — and the obvious way out of that is deleting rows.
with recursive up as (
  select id, id as root from tasks where parent_id is null
  union all
  select t.id, up.root from tasks t join up on t.parent_id = up.id
)
update tasks t set parent_id = up.root
  from up
 where t.id = up.id
   and t.parent_id is not null
   and t.parent_id <> up.root;

-- And no new ones, said as a key rather than as a rule somebody has to remember. `parent_of_root`
-- is null exactly when there is no parent, and a foreign key with a null in it is satisfied — so
-- a root is unconstrained and a child must point at a row that is itself a root.
alter table tasks
  add column is_root boolean generated always as (parent_id is null) stored,
  add column parent_of_root boolean generated always as (
    case when parent_id is null then null else true end
  ) stored;
alter table tasks add constraint tasks_root_identity unique (id, is_root);
alter table tasks add constraint tasks_no_grandchildren
  foreign key (parent_of_root, parent_id) references tasks (is_root, id);

-- migrate:down

-- What was flattened stays flattened. Where a task used to hang is recorded nowhere, and guessing
-- it back would put work under a parent it never had.
alter table tasks drop constraint tasks_no_grandchildren;
alter table tasks drop constraint tasks_root_identity;
alter table tasks drop column parent_of_root;
alter table tasks drop column is_root;
