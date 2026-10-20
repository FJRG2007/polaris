-- Which automation a Watch alarm was carried into, once the boot step that moves
-- alarms to Automations has published its twin. Null while the alarm is still
-- Watch's own. A new nullable column only; nothing existing changes, and the
-- statement is a no-op when run a second time.
ALTER TABLE "Alarm" ADD COLUMN IF NOT EXISTS "carriedToId" UUID;
