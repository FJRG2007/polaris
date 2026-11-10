-- What deleting something left behind, removed once.
--
-- A grant, a line of the access log, a follow, a comment and a line of history
-- name what they are about by kind and id with no foreign key, so a delete
-- that did not drop them by hand left them on the disk about something that is
-- no longer there. From now on every delete does (lib/access/forget.ts); this
-- removes what earlier ones left.
--
-- Only rows whose subject or principal is a table row that no longer exists:
-- a kind whose id is a fixed or composite name (the network filter, the
-- internet record, a CRM record) is never touched, and an id is cast to uuid
-- only when it is shaped like one. A site's numbers are shared under the
-- service's id or, for Polaris itself and a site run elsewhere, under the
-- site record's, so either keeps its grants.
-- Data only and safe to run again: a second run finds nothing to delete.

-- Grants on something gone.
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'chat.space'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "ChatSpace" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'chat.channel'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "ChatChannel" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'task.space'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TaskSpace" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'task.folder'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TaskFolder" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'note.space'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "NoteSpace" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'office.document'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "OfficeDocument" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.device'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PlaceDevice" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.camera'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Camera" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.ups'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Ups" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.nas'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "StorageConnection" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.server'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Host" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.domain'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Domain" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.room'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PlaceRoom" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'watch.alarm'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Alarm" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'status.page'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "StatusPage" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'calendar.calendar'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Calendar" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'calendar.booking'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "CalendarBookingPage" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'crm.dashboard'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "CrmDashboard" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'automation.automation'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Automation" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'analytics.site'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Application" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END)
  AND NOT EXISTS (SELECT 1 FROM "AnalyticsSite" t WHERE t."id" = g."subjectId");
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'telemetry.project'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TelemetryProject" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'backup.plan'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "BackupPlan" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'note.note'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Note" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'agents.session'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "AgentSession" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'polar.project'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PolarProject" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'task.task'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.place'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Place" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'mail.mailbox'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "MailAccount" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."subjectType" = 'place.panel'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PlacePanel" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);

-- Grants to a person, team or role that is gone.
DELETE FROM "AccessGrant" g
WHERE g."principalType" = 'user'
  AND g."principalId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "User" t WHERE t."id" = CASE WHEN g."principalId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."principalId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."principalType" = 'team'
  AND g."principalId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Team" t WHERE t."id" = CASE WHEN g."principalId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."principalId"::text::uuid END);
DELETE FROM "AccessGrant" g
WHERE g."principalType" = 'role'
  AND g."principalId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "OrgRole" t WHERE t."id" = CASE WHEN g."principalId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."principalId"::text::uuid END);

-- The access log of something gone.
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'chat.space'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "ChatSpace" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'chat.channel'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "ChatChannel" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'task.space'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TaskSpace" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'task.folder'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TaskFolder" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'note.space'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "NoteSpace" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'office.document'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "OfficeDocument" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.device'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PlaceDevice" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.camera'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Camera" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.ups'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Ups" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.nas'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "StorageConnection" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.server'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Host" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.domain'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Domain" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.room'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PlaceRoom" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'watch.alarm'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Alarm" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'status.page'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "StatusPage" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'calendar.calendar'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Calendar" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'calendar.booking'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "CalendarBookingPage" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'crm.dashboard'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "CrmDashboard" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'automation.automation'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Automation" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'analytics.site'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Application" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END)
  AND NOT EXISTS (SELECT 1 FROM "AnalyticsSite" t WHERE t."id" = g."subjectId");
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'telemetry.project'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "TelemetryProject" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'backup.plan'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "BackupPlan" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'note.note'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Note" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'agents.session'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "AgentSession" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'polar.project'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PolarProject" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'task.task'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.place'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Place" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'mail.mailbox'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "MailAccount" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "GrantUse" g
WHERE g."subjectType" = 'place.panel'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "PlacePanel" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);

-- Activity rows about something gone.
DELETE FROM "Activity" g
WHERE g."subjectType" = 'task'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "Activity" g
WHERE g."subjectType" = 'app'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Application" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "Activity" g
WHERE g."subjectType" = 'host'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Host" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);

-- Comment rows about something gone.
DELETE FROM "Comment" g
WHERE g."subjectType" = 'task'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "Comment" g
WHERE g."subjectType" = 'app'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Application" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "Comment" g
WHERE g."subjectType" = 'host'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Host" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);

-- Follow rows about something gone.
DELETE FROM "Follow" g
WHERE g."subjectType" = 'task'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "Follow" g
WHERE g."subjectType" = 'app'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Application" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "Follow" g
WHERE g."subjectType" = 'host'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "Host" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);
DELETE FROM "Follow" g
WHERE g."subjectType" = 'user'
  AND g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM "User" t WHERE t."id" = CASE WHEN g."subjectId"::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g."subjectId"::text::uuid END);

-- A service's numbers whose service is gone, with everything recorded for it
-- by cascade (sessions, events, days, reports).
DELETE FROM "AnalyticsSite" s
WHERE s."scopeType" = 'application'
  AND NOT EXISTS (SELECT 1 FROM "Application" t WHERE t."id"::text = s."scopeId");
