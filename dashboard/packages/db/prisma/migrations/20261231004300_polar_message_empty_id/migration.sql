-- Polar answers were stored under an empty id until the chat route started
-- naming them. Only the first such answer ever written got a row; it is given an
-- id of its own here so it stays readable and stops standing in for later ones.
-- The new id is derived from its thread, so both statements agree on it without
-- a variable, and a message that was answered from it keeps pointing at it.
--
-- Every statement is written so that running it a second time is a no-op: once
-- no row has an empty id, neither of them matches anything.
UPDATE "PolarMessage" AS child
SET "parentId" = 'restored-' || child."threadId"::text
WHERE child."parentId" = ''
  AND EXISTS (
      SELECT 1 FROM "PolarMessage" AS stored
      WHERE stored."id" = '' AND stored."threadId" = child."threadId"
  );

UPDATE "PolarMessage"
SET "id" = 'restored-' || "threadId"::text
WHERE "id" = '';
