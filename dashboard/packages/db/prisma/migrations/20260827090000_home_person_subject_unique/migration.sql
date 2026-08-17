-- A person's subject is what the recognition service files their photographs
-- under, and it no longer moves when their name is corrected. That makes an old
-- name free again, so two people could end up sharing one subject - and a
-- shared subject is a shared face. Uniqueness is what makes that impossible
-- rather than unlikely.
--
-- Nothing existing can violate it: until now the subject was set from the name
-- and the name was already unique per install.

-- CreateIndex
CREATE UNIQUE INDEX "HomePerson_installedAppId_subjectId_key" ON "HomePerson"("installedAppId", "subjectId");
