-- Pictures a message's own HTML draws, listed as files.
--
-- The previous change stopped taking every part with a Content-Id for part of
-- the body, which put iPhone attachments back on the list - and also a
-- newsletter's icons, which sit beside the HTML the same way. The body is what
-- tells them apart: a picture it asks for by cid is one it draws. Stored bodies
-- are checked here; new mail is checked as its body arrives. Each statement only
-- moves rows toward that state, so a second run changes nothing.
UPDATE "MailAttachment" AS a
SET "inline" = true
FROM "MailMessage" AS m
WHERE a."messageId" = m."id"
  AND a."inline" = false
  AND a."contentType" LIKE 'image/%'
  AND a."contentId" <> ''
  AND m."bodyHtml" IS NOT NULL
  AND position(lower('cid:' || a."contentId") in lower(m."bodyHtml")) > 0;

UPDATE "MailMessage" AS m
SET "hasAttachments" = false
WHERE m."hasAttachments" = true
  AND EXISTS (SELECT 1 FROM "MailAttachment" AS a WHERE a."messageId" = m."id")
  AND NOT EXISTS (
      SELECT 1 FROM "MailAttachment" AS a
      WHERE a."messageId" = m."id" AND a."inline" = false
  );

UPDATE "MailThread" AS t
SET "hasAttachments" = false
WHERE t."hasAttachments" = true
  AND NOT EXISTS (
      SELECT 1 FROM "MailMessage" AS m
      WHERE m."threadId" = t."id" AND m."hasAttachments" = true
  );
