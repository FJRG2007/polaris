-- A grant can be fenced to the place it opens: the act is allowed only when the
-- browser reports a location within this many metres. Additive and nullable:
-- every existing grant keeps working from anywhere, as it did.
ALTER TABLE "AccessGrant" ADD COLUMN "nearbyMeters" INTEGER;
