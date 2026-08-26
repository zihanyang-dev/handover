-- Finding a machine's next question used to read every message on the deployment.
--
-- The question is always "the last thing somebody said in this conversation", and the only way to
-- ask that per conversation is an index that holds the questions in order. Without one, Postgres
-- reads every message anywhere, keeps the tenth of them that are questions, and throws away the
-- ones belonging to other machines: measured at 198,000 rows read and 2,622 buffers to answer one
-- machine's check-in, growing with everything anybody has ever said anywhere on the deployment.
--
-- Partial, because only questions are ever looked up this way. It is a tenth of the table.

-- migrate:up
create index messages_asked on messages (conversation_id, seq) where role = 'user';

-- migrate:down
drop index messages_asked;
