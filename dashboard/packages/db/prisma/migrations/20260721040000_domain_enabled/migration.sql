-- Per-domain enable/disable toggle; enabled by default so existing routes keep serving.
ALTER TABLE "Domain" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
