-- Tell the owner of a service when one of its domains stops serving.
--
-- The probe already recorded reachability for the UI, but nothing raised it: an alert
-- needed a Watch alarm somebody had thought to create by hand, so a domain going down
-- was visible to whoever opened the page and to nobody else.
--
-- Two columns rather than one: the streak stops a single bad probe becoming a page,
-- and the alert timestamp is what stops a domain that stays down alerting every minute
-- and what says a recovery is worth mentioning at all.
ALTER TABLE "Domain" ADD COLUMN "healthFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Domain" ADD COLUMN "healthAlertedAt" TIMESTAMP(3);
