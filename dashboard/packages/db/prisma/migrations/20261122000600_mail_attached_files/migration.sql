-- Files somebody attached that were stored as part of the message body.
--
-- A part with a Content-Id and an inline disposition was taken for a picture the
-- message draws, and kept off the list of files. Apple Mail and the phone apps
-- send every attachment that way, so a PDF or a document attached from them was
-- shown nowhere. Only a picture can be drawn by a message, so anything else
-- stored as inline is a file, and the paperclip on its message and conversation
-- is put back to match. Every statement only moves rows toward that state, so a
-- second run changes nothing.
UPDATE "MailAttachment"
SET "inline" = false
WHERE "inline" = true AND "contentType" NOT LIKE 'image/%';

UPDATE "MailMessage" AS m
SET "hasAttachments" = true
WHERE m."hasAttachments" = false
  AND EXISTS (
      SELECT 1 FROM "MailAttachment" AS a
      WHERE a."messageId" = m."id" AND a."inline" = false
  );

UPDATE "MailThread" AS t
SET "hasAttachments" = true
WHERE t."hasAttachments" = false
  AND EXISTS (
      SELECT 1 FROM "MailMessage" AS m
      WHERE m."threadId" = t."id" AND m."hasAttachments" = true
  );
