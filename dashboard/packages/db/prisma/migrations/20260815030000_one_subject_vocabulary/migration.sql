-- One vocabulary for a subjectType column, not two.
--
-- MetricSample and MetricRollup have addressed subjects polymorphically since
-- long before Activity, Comment and Follow did, and they use the schema's own
-- words: `app` for an Application, `host` for a Host. The three new tables were
-- written with the interface's words instead - `service` and `server` - which
-- left an Application called two different things in two subjectType columns.
--
-- Renaming the rows rather than the convention: four tables would have to change
-- otherwise, and the older pair is the one with callers outside this feature.
--
-- Idempotent by construction: the WHERE clauses match nothing on a second run,
-- and nothing at all on an instance that never wrote a row under the old names.

UPDATE "Activity" SET "subjectType" = 'app' WHERE "subjectType" = 'service';
UPDATE "Activity" SET "subjectType" = 'host' WHERE "subjectType" = 'server';

UPDATE "Comment" SET "subjectType" = 'app' WHERE "subjectType" = 'service';
UPDATE "Comment" SET "subjectType" = 'host' WHERE "subjectType" = 'server';

UPDATE "Follow" SET "subjectType" = 'app' WHERE "subjectType" = 'service';
UPDATE "Follow" SET "subjectType" = 'host' WHERE "subjectType" = 'server';
