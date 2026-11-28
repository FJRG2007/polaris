-- The updater reads when a deployment is busiest (to find its quietest hour)
-- and whether anybody is serving or on a call right now (to step a scheduled
-- install back). Each read filters and sorts on a timestamp alone.
CREATE INDEX IF NOT EXISTS "HospitalityOrderLine_createdAt_idx" ON "HospitalityOrderLine"("createdAt");
CREATE INDEX IF NOT EXISTS "HospitalityPayment_createdAt_idx" ON "HospitalityPayment"("createdAt");
CREATE INDEX IF NOT EXISTS "MeetingParticipant_joinedAt_idx" ON "MeetingParticipant"("joinedAt");
CREATE INDEX IF NOT EXISTS "MeetingParticipant_leftAt_lastSeenAt_idx" ON "MeetingParticipant"("leftAt", "lastSeenAt");
