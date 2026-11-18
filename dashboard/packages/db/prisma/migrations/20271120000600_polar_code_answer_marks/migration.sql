-- Good and bad marks on an agent session's answers, read in Polar Code
-- (apps/web/src/lib/polar/answer-feedback-service.ts): a mark names either a
-- chat answer or an agent session's message. Additive and rerunnable.
ALTER TABLE "PolarAnswerFeedback" ADD COLUMN IF NOT EXISTS "sessionMessageId" UUID;
ALTER TABLE "PolarAnswerFeedback" ALTER COLUMN "messageId" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "PolarAnswerFeedback_userId_sessionMessageId_key" ON "PolarAnswerFeedback"("userId", "sessionMessageId");
ALTER TABLE "PolarAnswerFeedback" DROP CONSTRAINT IF EXISTS "PolarAnswerFeedback_sessionMessageId_fkey";
ALTER TABLE "PolarAnswerFeedback" ADD CONSTRAINT "PolarAnswerFeedback_sessionMessageId_fkey" FOREIGN KEY ("sessionMessageId") REFERENCES "AgentSessionMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Exactly one of the two answers a mark can name. Prisma's schema has no CHECK,
-- so this lives only here.
ALTER TABLE "PolarAnswerFeedback" DROP CONSTRAINT IF EXISTS "PolarAnswerFeedback_one_answer_check";
ALTER TABLE "PolarAnswerFeedback" ADD CONSTRAINT "PolarAnswerFeedback_one_answer_check" CHECK (("messageId" IS NULL) <> ("sessionMessageId" IS NULL));
