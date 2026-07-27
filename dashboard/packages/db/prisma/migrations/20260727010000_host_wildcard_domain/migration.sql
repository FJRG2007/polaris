-- The wildcard domain pointed at each registered server ("apps.example.com" ->
-- *.apps.example.com), so services deployed there get a real domain served by
-- that server's own edge instead of a hostname that encodes its IP. Null means
-- none is configured and the IP-derived free subdomain is used.
ALTER TABLE "Host" ADD COLUMN "wildcardDomain" TEXT;
