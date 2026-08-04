-- A certificate the operator supplied for one hostname, served by the edge instead of
-- the managed one.
--
-- The chain is public material and stored as PEM. The private key is encrypted at rest
-- with the master key, the same way every other secret here is, so a database dump
-- never carries a usable key.
--
-- Null for every existing domain, which keeps them on the managed certificate exactly
-- as they are today.
ALTER TABLE "Domain" ADD COLUMN "certPem" TEXT;
ALTER TABLE "Domain" ADD COLUMN "certKey" TEXT;
