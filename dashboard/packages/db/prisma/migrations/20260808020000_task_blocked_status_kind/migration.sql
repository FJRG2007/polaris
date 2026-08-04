-- "Blocked" becomes a kind of stage rather than just a stage with a name.
--
-- The product decides whether work is held up the way it decides whether work is
-- finished: from the kind, never from the word a team typed. Without a kind for it, a
-- task sitting in the Blocked column carried no marker, fell outside the "blocked"
-- filter and was grouped under "Not blocked" - the column said one thing and every
-- other screen said the opposite.
--
-- Only the stage the previous migration created is converted, matched on the three
-- values it wrote and nothing else. A stage a team made itself is left alone: the kind
-- is a claim about what a stage means, and guessing it from a name is exactly what the
-- kind exists to stop. They can say so themselves on the stage editor, which now offers
-- Blocked alongside the other kinds.
UPDATE "TaskStatus"
SET "type" = 'blocked'
WHERE "name" = 'Blocked' AND "type" = 'open' AND "color" = '#ef4444';
