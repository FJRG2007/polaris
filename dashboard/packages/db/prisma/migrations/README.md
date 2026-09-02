# Writing a migration

Two rules, both of them about the same thing: an installed Polaris applies these
on boot, unattended, against a database nobody is watching.

## A migration must survive being run twice

Postgres runs each statement for real. If the fourth one fails, the first three
have already happened and are not rolled back — so the deployment is left with a
table half changed, the history records the migration as failed, and every later
migration is refused. That is the end of updating for that install until somebody
restores a backup.

Write every statement so that running it a second time is a no-op, and the same
failure becomes a retry instead:

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

`prisma migrate dev` does not write it this way, so this is an edit you make by
hand afterwards. `test/updates/migrations-rerunnable.test.ts` checks it, and it
names the statement it wants.

## Never edit a migration that has shipped

Their text is checksummed. Changing an applied one stops the install updating —
the same outage the rule above exists to prevent. The test only binds migrations
written from `20261001000000` onwards for exactly this reason: everything before
it is already applied on real deployments and is left alone.

Correct a shipped migration by writing a new one after it.
