-- The identity a visit belongs to, where the game reports one.
--
-- A visit was recorded under the name the server printed, which is the identity on
-- Minecraft and decoration on ARK: there the roster prints the survivor's name
-- while the allow list holds whatever the operator typed, so a row for somebody
-- offline looked for a visit under a name no visit was ever recorded under and
-- found nothing to say. The Steam id is what the two halves agree on.
--
-- Null for every row already written, and for Minecraft for good. A row with no id
-- is the only kind still matched by name, so nothing already recorded is lost.

-- AlterTable
ALTER TABLE "GamePlayerSession" ADD COLUMN     "playerId" TEXT;

-- CreateIndex
CREATE INDEX "GamePlayerSession_installedAppId_playerId_idx" ON "GamePlayerSession"("installedAppId", "playerId");
