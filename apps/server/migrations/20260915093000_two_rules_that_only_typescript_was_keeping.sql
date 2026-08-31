-- Two rules the wire already enforced and the database did not.
--
-- `code-style.md` 9: a late writer has to fail in SQL, not only in TypeScript. Both of these are
-- checked by zod on the way in and both had exactly one writer, so neither is a hole anybody has
-- fallen into — what they are is the rule stopping one layer short of where it was meant to land.
-- Every other column a person can see carries its bound twice; these two carried it once.

-- migrate:up

-- What a machine calls itself. `enrolment-api.ts` takes `z.string().min(1).max(200)`, and this is
-- the same sentence in the place a second writer would meet it. Trimmed first, because a name
-- that only differs by the spaces around it is the same name and the constraint should not be the
-- thing that discovers that.
update machines set name = btrim(name) where name <> btrim(name);

alter table machines
  add constraint machines_name_check
  check (btrim(name) = name and char_length(name) between 1 and 200);

-- An enrolment is one of two shapes, and TypeScript says so with a union: a machine that is
-- asking has a name and a code somebody reads aloud, a key that arrived approved has neither.
-- Both are written once, at insert, and never changed afterwards — the approval that follows
-- touches `approved_by` and `approved_at` and nothing here. So the two columns are present
-- together or absent together, for the whole life of the row.
alter table enrolments
  add constraint enrolments_asking_has_a_name_and_a_code
  check ((machine_name is null) = (user_code is null));

-- migrate:down

alter table enrolments drop constraint enrolments_asking_has_a_name_and_a_code;
alter table machines drop constraint machines_name_check;
