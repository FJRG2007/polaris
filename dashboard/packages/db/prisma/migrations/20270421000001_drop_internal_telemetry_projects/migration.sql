-- Every deploy used to give its project a telemetry project, including the
-- "marketplace" project Polaris installs apps into. That one is nobody's code
-- and is no longer listed or created, so the rows made for it go (their issues
-- and events go with them through the foreign keys).
DELETE FROM "TelemetryProject" t
USING "Project" p
WHERE t."deployProjectId" = p."id"
  AND p."slug" = 'marketplace'
  AND t."system" = false;
