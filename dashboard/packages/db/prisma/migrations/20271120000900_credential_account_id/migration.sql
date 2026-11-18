-- A password sign-in finds the password by the account's own id.
--
-- better-auth reads the password from the "credential" Account row whose
-- "accountId" equals the user's id, and answers "Invalid email or password"
-- when there is none - before the password is ever compared. Rows written before
-- user ids became native uuids still carry the 32-character id the user had
-- then, so the account behind them is refused with the right password, every
-- time, while every other way in (passkey, QR, emailed link) keeps working.
--
-- Nothing else reads a credential row's "accountId": better-auth's own writes
-- (sign-up, provisioning, setting a password) all set it to the user's id, which
-- is what this restores. A user that already has a matching row is left alone,
-- so this cannot create a second one.
--
-- Rerunnable: the second run matches no rows. Not reversed: the old value names
-- no user and nothing looks it up.

UPDATE "Account" AS a
SET "accountId" = a."userId"::text, "updatedAt" = now()
WHERE a."providerId" = 'credential'
  AND a."accountId" <> a."userId"::text
  AND NOT EXISTS (
      SELECT 1 FROM "Account" AS b
      WHERE b."userId" = a."userId"
        AND b."providerId" = 'credential'
        AND b."accountId" = a."userId"::text
  )
  AND a."id" = (
      SELECT c."id" FROM "Account" AS c
      WHERE c."userId" = a."userId" AND c."providerId" = 'credential'
      ORDER BY c."password" IS NULL, c."updatedAt" DESC
      LIMIT 1
  );
