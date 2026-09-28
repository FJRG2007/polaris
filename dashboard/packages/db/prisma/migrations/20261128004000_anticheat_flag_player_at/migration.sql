-- A player's anti-cheat alerts, newest first: the Anti-cheat tab reads the last
-- twenty of each player's. The new index leads with the same two columns as the
-- one it replaces, so nothing that used that one loses it.
DROP INDEX IF EXISTS "MinecraftAnticheatFlag_installedAppId_player_idx";
CREATE INDEX IF NOT EXISTS "MinecraftAnticheatFlag_installedAppId_player_at_idx" ON "MinecraftAnticheatFlag"("installedAppId", "player", "at");
