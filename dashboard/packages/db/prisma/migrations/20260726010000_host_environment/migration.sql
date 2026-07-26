-- Where each registered server lives (home-nat | home-cgnat | vps | cloud), which
-- decides how a domain can be pointed at it. Existing rows start unclassified and
-- are detected or asked about on next visit.
ALTER TABLE "Host" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'unknown';
