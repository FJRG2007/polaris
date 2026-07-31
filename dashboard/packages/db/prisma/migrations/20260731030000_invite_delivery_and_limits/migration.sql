-- Restrictions an administrator imposes on an account. Separate from the
-- account's own rules because the two are judged independently: a sign-in must
-- satisfy both, so nothing the user does under Account > Security can widen or
-- drop what an administrator set.
ALTER TABLE "UserSecurity" ADD COLUMN "adminCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "UserSecurity" ADD COLUMN "adminCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "UserSecurity" ADD COLUMN "adminContinents" TEXT NOT NULL DEFAULT '[]';

-- An access group attached by an administrator rather than by the account
-- itself. Existing bindings were all made by their owner, so false is right.
ALTER TABLE "UserAccessGroup" ADD COLUMN "enforced" BOOLEAN NOT NULL DEFAULT false;

-- How an invite travels and what the recipient presents to claim it, plus the
-- limits it carries: where it may be claimed from, and the restrictions the
-- account keeps afterwards. Invites written before this all travelled as links.
ALTER TABLE "Invite" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'link';
ALTER TABLE "Invite" ADD COLUMN "codeHash" TEXT;
ALTER TABLE "Invite" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "Invite" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "Invite" ADD COLUMN "allowedCidrs" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Invite" ADD COLUMN "allowedCountries" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Invite" ADD COLUMN "allowedContinents" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Invite" ADD COLUMN "accessGroupIds" TEXT NOT NULL DEFAULT '[]';

CREATE UNIQUE INDEX "Invite_codeHash_key" ON "Invite"("codeHash");
