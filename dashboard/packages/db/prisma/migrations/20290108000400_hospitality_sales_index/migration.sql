-- Best sellers of the last 30 days: paid orders of a venue by close date. Without it
-- the menu read scanned every order the venue ever took.
CREATE INDEX IF NOT EXISTS "HospitalityOrder_venueId_status_closedAt_idx" ON "HospitalityOrder"("venueId", "status", "closedAt");
