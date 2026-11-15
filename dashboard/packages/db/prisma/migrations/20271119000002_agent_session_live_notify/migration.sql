-- Tell every dashboard process when an agent session changed, whichever process
-- (or script) wrote it. Each process holds one LISTEN connection on
-- "polaris_agent_session" (apps/web/src/lib/live/pg-listener.ts) and wakes the
-- pages it has open for that session, which then read the rows themselves.
--
-- The payload is the session id and which table moved - never row content - so
-- it stays a few dozen bytes, far under Postgres' 8000-byte NOTIFY limit, and
-- identical notices inside one transaction are folded into one by Postgres.
-- A trigger rather than a call beside each write, so a write added tomorrow
-- that forgets to announce itself is still seen by the other replicas.
CREATE OR REPLACE FUNCTION "polaris_agent_session_notify"() RETURNS trigger AS $$
DECLARE
    sid uuid;
    kind text;
BEGIN
    IF TG_TABLE_NAME = 'AgentSession' THEN
        kind := 'session';
        IF TG_OP = 'DELETE' THEN sid := OLD."id"; ELSE sid := NEW."id"; END IF;
    ELSE
        kind := CASE TG_TABLE_NAME
            WHEN 'AgentSessionEvent' THEN 'event'
            WHEN 'AgentSessionMessage' THEN 'message'
            ELSE 'permission'
        END;
        IF TG_OP = 'DELETE' THEN sid := OLD."sessionId"; ELSE sid := NEW."sessionId"; END IF;
    END IF;
    PERFORM pg_notify('polaris_agent_session', json_build_object('s', sid, 'k', kind)::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AgentSession_live_notify" ON "AgentSession";
CREATE TRIGGER "AgentSession_live_notify"
    AFTER INSERT OR UPDATE OR DELETE ON "AgentSession"
    FOR EACH ROW EXECUTE FUNCTION "polaris_agent_session_notify"();

DROP TRIGGER IF EXISTS "AgentSessionEvent_live_notify" ON "AgentSessionEvent";
CREATE TRIGGER "AgentSessionEvent_live_notify"
    AFTER INSERT OR UPDATE OR DELETE ON "AgentSessionEvent"
    FOR EACH ROW EXECUTE FUNCTION "polaris_agent_session_notify"();

DROP TRIGGER IF EXISTS "AgentSessionMessage_live_notify" ON "AgentSessionMessage";
CREATE TRIGGER "AgentSessionMessage_live_notify"
    AFTER INSERT OR UPDATE OR DELETE ON "AgentSessionMessage"
    FOR EACH ROW EXECUTE FUNCTION "polaris_agent_session_notify"();

DROP TRIGGER IF EXISTS "AgentPermissionRequest_live_notify" ON "AgentPermissionRequest";
CREATE TRIGGER "AgentPermissionRequest_live_notify"
    AFTER INSERT OR UPDATE OR DELETE ON "AgentPermissionRequest"
    FOR EACH ROW EXECUTE FUNCTION "polaris_agent_session_notify"();
