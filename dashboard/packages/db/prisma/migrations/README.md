# Writing a migration

Two rules, both of them about the same thing: an installed Polaris applies these
on boot, unattended, against a database nobody is watching.

## A migration must survive being run twice

Postgres runs each statement for real. If the fourth one fails, the first three
have already happened and are not rolled back - so the deployment is left with a
table half changed, the history records the migration as failed, and every later
migration is refused.

Write every statement so that running it a second time is a no-op, and that
failure becomes a retry instead: the entrypoint clears the failed row and runs
the migration once more by itself, and the second run finishes what the first one
started. It does that only for migrations this rule covers, so a statement that
cannot be repeated is the difference between an install that recovers on its own
and one that needs a backup restored.

```sql
CREATE TABLE IF NOT EXISTS "Thing" (...);
ALTER TABLE "Thing" ADD COLUMN IF NOT EXISTS "note" TEXT;
CREATE INDEX IF NOT EXISTS "Thing_note_idx" ON "Thing"("note");
DROP INDEX IF EXISTS "Thing_old_idx";
```

A constraint has no conditional form, so drop the name before adding it:

```sql
ALTER TABLE "Thing" DROP CONSTRAINT IF EXISTS "Thing_pkey";
ALTER TABLE "Thing" ADD CONSTRAINT "Thing_pkey" PRIMARY KEY ("id");
```

The same applies to the foreign keys Prisma rewrites - `DROP CONSTRAINT` on its
own fails the second time, so it is always `DROP CONSTRAINT IF EXISTS`.

A data statement has no conditional form at all: nothing about `INSERT` is a
no-op, so a backfill run twice writes its rows twice. Say what should happen when
they are already there:

```sql
INSERT INTO "Thing" ("id", "note") VALUES (gen_random_uuid(), 'seed')
ON CONFLICT DO NOTHING;
```

An `INSERT ... SELECT` that cannot name a conflict target does it with `WHERE NOT
EXISTS` on the rows it would duplicate.

`prisma migrate dev` does not write any of this, so it is an edit you make by
hand afterwards. `test/updates/migrations-rerunnable.test.ts` checks it, and it
names the statement it wants.

## Never edit a migration that has shipped

Their text is checksummed. Changing an applied one stops the install updating -
the same outage the rule above exists to prevent. The test only binds migrations
written from `20260930110001` onwards for exactly this reason: everything before
it is already applied on real deployments and is left alone.

Correct a shipped migration by writing a new one after it.
