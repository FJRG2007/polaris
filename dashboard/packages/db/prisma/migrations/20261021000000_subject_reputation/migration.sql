-- One reputation cache for the whole platform, whatever was looked up.
--
-- Polaris already remembered what a provider said about an IP, for the firewall
-- and for share links. Mail needs the same thing about two more kinds of
-- subject - the address a message came from, and the domain behind it - and
-- there is no reason for those to be a second cache with a second expiry and a
-- second thing for an administrator to clear.
--
-- So the key is what was asked about rather than an address: a kind, the value,
-- and the provider that answered. A question asked by the mail filter is
-- therefore answered from the firewall's lookup and the other way round, which
-- is the point - both of them pay per request, and a domain does not become
-- reputable for one part of Polaris and not the other.
--
-- `rules` is the question the verdict was reached under. Changing what counts as
-- bad is a different question, so it is asked again rather than answered out of
-- a cache that predates the change.
CREATE TABLE IF NOT EXISTS "SubjectReputation" (
    -- ip | domain | email
    "kind"      TEXT NOT NULL,
    -- Normalised by the caller: lower case, and an address without its tag.
    "subject"   TEXT NOT NULL,
    -- dymo | virustotal
    "provider"  TEXT NOT NULL,
    "allow"     BOOLEAN NOT NULL,
    "reason"    TEXT,
    "rules"     TEXT NOT NULL DEFAULT '',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubjectReputation_pkey" PRIMARY KEY ("kind", "subject", "provider")
);

-- The sweep that drops what nobody will read again reads this.
CREATE INDEX IF NOT EXISTS "SubjectReputation_checkedAt_idx"
    ON "SubjectReputation"("checkedAt");

-- An administrator clearing one kind, which is the invalidation that gets asked
-- for: "look at every domain again" without throwing away the addresses the
-- firewall is mid-sweep on.
CREATE INDEX IF NOT EXISTS "SubjectReputation_kind_checkedAt_idx"
    ON "SubjectReputation"("kind", "checkedAt");
