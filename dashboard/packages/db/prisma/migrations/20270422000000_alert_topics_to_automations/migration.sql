-- Alert topics become automations: "When an alert arrives" followed by
-- "Notify about the alert". Each topic keeps its id and secret, so every address
-- an integration already posts to keeps working: the automation takes the
-- topic's id, and its alert address takes the topic's id and secret hash.
-- Rerunnable: every insert is ON CONFLICT DO NOTHING, so a second run finishes
-- a topic the first one left half carried. A topic whose id an unrelated
-- automation already has is left out. The old tables are dropped by the next migration, which always runs
-- after this one.

-- gen_random_uuid() is built in on PG 13+ and lives in pgcrypto before that.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "AutomationAlertAddress" (
    "id" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenTail" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationAlertAddress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutomationAlertAddress_automationId_nodeId_key" ON "AutomationAlertAddress"("automationId", "nodeId");

ALTER TABLE "AutomationAlertAddress" DROP CONSTRAINT IF EXISTS "AutomationAlertAddress_automationId_fkey";
ALTER TABLE "AutomationAlertAddress" ADD CONSTRAINT "AutomationAlertAddress_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The graph each topic becomes, asserted node for node in
-- apps/web/test/alerts/addresses.test.ts.
DROP TABLE IF EXISTS "_alert_topic_carry";
CREATE TEMP TABLE "_alert_topic_carry" AS
SELECT
    t."id",
    t."ownerId",
    t."orgId",
    t."name",
    t."tokenHash",
    t."tokenTail",
    t."lastUsedAt",
    t."createdAt",
    jsonb_build_object(
        'schema', 1,
        'timeZone', 'UTC',
        'nodes', jsonb_build_array(
            jsonb_build_object(
                'id', 'alert',
                'type', 'core.alertIn',
                'typeVersion', 1,
                'position', jsonb_build_object('x', 0, 'y', 0),
                'config', jsonb_build_object(
                    'addressId', t."id"::text,
                    'defaultPriority', GREATEST(1, LEAST(5, t."defaultPriority"))
                )
            ),
            jsonb_build_object(
                'id', 'notify',
                'type', 'core.alertNotify',
                'typeVersion', 1,
                'position', jsonb_build_object('x', 0, 'y', 160),
                'config', jsonb_build_object(
                    'title', '{{trigger.title}}',
                    'body', '{{trigger.message}}',
                    'priority', '{{trigger.priority}}',
                    'pushFrom', GREATEST(2, LEAST(5, t."pushFrom")),
                    'click', '{{trigger.click}}',
                    'dedupKey', '{{trigger.dedupKey}}',
                    'recipientUserIds', CASE WHEN t."orgId" IS NULL THEN '[]'::jsonb
                        ELSE to_jsonb(COALESCE(t."recipientUserIds", ARRAY[]::UUID[])::TEXT[]) END,
                    'recipientTeamIds', CASE WHEN t."orgId" IS NULL THEN '[]'::jsonb
                        ELSE to_jsonb(COALESCE(t."recipientTeamIds", ARRAY[]::UUID[])::TEXT[]) END
                )
            )
        ),
        'edges', jsonb_build_array(
            jsonb_build_object(
                'from', jsonb_build_object('node', 'alert', 'port', 'next'),
                'to', jsonb_build_object('node', 'notify')
            )
        ),
        'finally', jsonb_build_object('entry', NULL, 'onCancel', false)
    ) AS "graph"
FROM "AlertTopic" t
WHERE NOT EXISTS (
    SELECT 1 FROM "Automation" a
    WHERE a."id" = t."id" AND a."legacyRef" IS DISTINCT FROM 'alert-topic:' || t."id"::text
);

-- Published and on, running as the topic's owner, on the shelf the topic was on.
-- Alerts arrive in bursts: every one is delivered, side by side.
INSERT INTO "Automation" (
    "id", "orgId", "userId", "name", "description", "enabled", "draft", "draftUpdatedAt",
    "runAsId", "mode", "maxRuns", "rateLimit", "legacyRef", "lastRunAt", "createdAt", "updatedAt"
)
SELECT
    c."id", c."orgId", CASE WHEN c."orgId" IS NULL THEN c."ownerId" ELSE NULL END,
    LEFT(c."name", 200), '', true, c."graph", CURRENT_TIMESTAMP,
    c."ownerId", 'parallel', 20, 500, 'alert-topic:' || c."id"::text, c."lastUsedAt", c."createdAt", CURRENT_TIMESTAMP
FROM "_alert_topic_carry" c
ON CONFLICT DO NOTHING;

INSERT INTO "AutomationVersion" ("id", "automationId", "number", "graph", "savedById", "createdAt")
SELECT gen_random_uuid(), c."id", 1, c."graph", c."ownerId", CURRENT_TIMESTAMP
FROM "_alert_topic_carry" c
JOIN "Automation" a ON a."id" = c."id" AND a."legacyRef" = 'alert-topic:' || c."id"::text
ON CONFLICT DO NOTHING;

UPDATE "Automation" a
SET "publishedVersionId" = v."id"
FROM "_alert_topic_carry" c, "AutomationVersion" v
WHERE a."id" = c."id" AND a."legacyRef" = 'alert-topic:' || c."id"::text AND v."automationId" = a."id" AND v."number" = 1 AND a."publishedVersionId" IS NULL;

-- Armed as a publish arms it (lib/automations/triggers.ts): the address id is the subject.
INSERT INTO "AutomationTrigger" ("id", "automationId", "versionId", "nodeId", "eventType", "subjectKey", "state", "createdAt")
SELECT
    gen_random_uuid(), c."id", a."publishedVersionId", 'alert', 'core.alert', c."id"::text,
    jsonb_build_object('config', ((c."graph" -> 'nodes') -> 0 -> 'config')::text), CURRENT_TIMESTAMP
FROM "_alert_topic_carry" c
JOIN "Automation" a ON a."id" = c."id" AND a."legacyRef" = 'alert-topic:' || c."id"::text AND a."publishedVersionId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "AutomationAlertAddress" ("id", "automationId", "nodeId", "tokenHash", "tokenTail", "lastUsedAt", "createdAt")
SELECT c."id", c."id", 'alert', c."tokenHash", c."tokenTail", c."lastUsedAt", c."createdAt"
FROM "_alert_topic_carry" c
JOIN "Automation" a ON a."id" = c."id" AND a."legacyRef" = 'alert-topic:' || c."id"::text
ON CONFLICT DO NOTHING;

-- Every alert a topic received stays in its history, as a finished run of the
-- automation it became: the run takes the delivery's id, its trigger step holds
-- the alert as the trigger hands it (lib/alerts/addresses.ts alertCause), and
-- its notify step how many people it reached. A test send stays a test run.
INSERT INTO "AutomationRun" (
    "id", "automationId", "versionId", "status", "triggerNodeId", "cause", "firingKey",
    "test", "stepCount", "queuedAt", "startedAt", "finishedAt"
)
SELECT
    d."id", a."id", a."publishedVersionId", 'succeeded', 'alert',
    jsonb_build_object(
        'id', 'alert',
        'at', to_char(d."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'title', d."title",
        'message', d."message",
        'markdown', d."markdown",
        'priority', d."priority",
        'tags', array_to_string(d."tags", ', '),
        'click', COALESCE(d."click", ''),
        'actions', d."actions",
        'dedupKey', COALESCE(d."dedupKey", ''),
        'source', d."source"
    ),
    'alert:delivery:' || d."id"::text,
    d."source" = 'test', 2, d."createdAt", d."createdAt", d."createdAt"
FROM "AlertDelivery" d
JOIN "Automation" a ON a."legacyRef" = 'alert-topic:' || d."topicId"::text AND a."publishedVersionId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "AutomationStep" ("id", "runId", "nodeId", "iteration", "attempt", "status", "port", "output", "createdAt", "startedAt", "finishedAt")
SELECT gen_random_uuid(), r."id", 'alert', '0', 1, 'ok', 'next', r."cause", r."queuedAt", r."queuedAt", r."queuedAt"
FROM "AutomationRun" r
JOIN "AlertDelivery" d ON d."id" = r."id" AND r."firingKey" = 'alert:delivery:' || d."id"::text
ON CONFLICT DO NOTHING;

INSERT INTO "AutomationStep" ("id", "runId", "nodeId", "iteration", "attempt", "status", "port", "output", "createdAt", "startedAt", "finishedAt")
SELECT
    gen_random_uuid(), r."id", 'notify', '0', 1, 'ok', 'next',
    jsonb_build_object('recipients', d."recipients", 'priority', d."priority"),
    r."queuedAt", r."queuedAt", r."queuedAt"
FROM "AutomationRun" r
JOIN "AlertDelivery" d ON d."id" = r."id" AND r."firingKey" = 'alert:delivery:' || d."id"::text
ON CONFLICT DO NOTHING;

UPDATE "Automation"
SET "lastStatus" = 'succeeded'
WHERE "legacyRef" LIKE 'alert-topic:%' AND "lastRunAt" IS NOT NULL AND "lastStatus" IS NULL;

-- Notifications an alert left open the page that is gone; they open the run the
-- delivery became, or the automation the topic became when there is no run.
UPDATE "Notification" n
SET "href" = '/automations/runs/' || r."id"::text
FROM "AutomationRun" r
WHERE n."href" = '/account/alerts/d/' || r."id"::text AND r."firingKey" = 'alert:delivery:' || r."id"::text;

UPDATE "Notification" n
SET "href" = '/automations/' || a."id"::text
FROM "AlertDelivery" d
JOIN "Automation" a ON a."legacyRef" = 'alert-topic:' || d."topicId"::text
WHERE n."href" = '/account/alerts/d/' || d."id"::text;

UPDATE "Notification"
SET "href" = '/automations'
WHERE "href" LIKE '/account/alerts%';

DROP TABLE IF EXISTS "_alert_topic_carry";
