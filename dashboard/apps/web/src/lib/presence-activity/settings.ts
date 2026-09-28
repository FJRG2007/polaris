/**
 * Whether somebody shares what they are doing, and from where - read and written.
 *
 * No row is the defaults, as it is for every other privacy setting: an account
 * that never opened the screen has not asked for anything. The JSON lists are
 * read entry by entry (`readStoredList`), so one entry an older build wrote in a
 * shape this one does not accept costs that entry, never the whole hide list.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** One account's settings, with the games its desktop app has seen. */
export interface ActivitySettingsView {
    readonly settings: core.ActivitySettings;
    readonly seenGames: readonly core.SeenGame[];
}

type Row = {
    share: boolean;
    spotify: boolean;
    games: boolean;
    minecraft: boolean;
    hiddenGames: string;
    customGames: string;
    seenGames: string;
};

const COLUMNS = {
    share: true,
    spotify: true,
    games: true,
    minecraft: true,
    hiddenGames: true,
    customGames: true,
    seenGames: true
} as const;

/** A stored row, as the schema reads it. */
export function settingsFromRow(row: Row | null | undefined): core.ActivitySettings {
    if (!row) return core.DEFAULT_ACTIVITY_SETTINGS;
    return {
        share: row.share,
        spotify: row.spotify,
        games: row.games,
        minecraft: row.minecraft,
        hiddenGames: core.readStoredList(row.hiddenGames, core.gameKeySchema),
        customGames: core.readStoredList(row.customGames, core.customGameSchema)
    };
}

export async function activitySettingsOf(userId: string): Promise<ActivitySettingsView> {
    const row = await prisma.userActivitySettings.findUnique({
        where: { userId },
        select: COLUMNS
    });
    return {
        settings: settingsFromRow(row),
        seenGames: core.readStoredList(row?.seenGames, core.seenGameSchema)
    };
}

/** Several accounts' settings at once, for a page of faces. Missing is defaults. */
export async function activitySettingsFor(
    userIds: readonly string[]
): Promise<Map<string, core.ActivitySettings>> {
    const wanted = [...new Set(userIds)];
    const found = new Map<string, core.ActivitySettings>();
    if (wanted.length === 0) return found;
    const rows = await prisma.userActivitySettings.findMany({
        where: { userId: { in: wanted } },
        select: { userId: true, ...COLUMNS }
    });
    const byId = new Map(rows.map((row) => [row.userId, row]));
    for (const userId of wanted) found.set(userId, settingsFromRow(byId.get(userId)));
    return found;
}

/** Save the whole set. Already validated by the caller's schema. */
export async function saveActivitySettings(
    userId: string,
    settings: core.ActivitySettings
): Promise<void> {
    const data = {
        share: settings.share,
        spotify: settings.spotify,
        games: settings.games,
        minecraft: settings.minecraft,
        hiddenGames: JSON.stringify(settings.hiddenGames),
        customGames: JSON.stringify(settings.customGames)
    };
    await prisma.userActivitySettings.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data
    });
}

/**
 * Remember a game the desktop app saw, newest first, so it can be hidden by name
 * after it has been closed.
 *
 * Only written when it changes the list - a game already at the top is the
 * common case, and a write every minute of every session for it would be a
 * write for nothing.
 */
export async function rememberSeenGame(
    userId: string,
    game: { key: string; name: string },
    now: Date = new Date()
): Promise<void> {
    const row = await prisma.userActivitySettings.findUnique({
        where: { userId },
        select: { seenGames: true }
    });
    const seen = core.readStoredList(row?.seenGames, core.seenGameSchema);
    const top = seen[0];
    if (top && top.key === game.key && top.name === game.name) return;
    const next: core.SeenGame[] = [
        { key: game.key, name: game.name, seenAt: now.toISOString() },
        ...seen.filter((entry) => entry.key !== game.key)
    ].slice(0, core.MOST_SEEN_GAMES);
    await prisma.userActivitySettings.upsert({
        where: { userId },
        create: { userId, seenGames: JSON.stringify(next) },
        update: { seenGames: JSON.stringify(next) }
    });
}
