/**
 * Who administers an ARK server from inside the game.
 *
 * ARK has no operator list the way Minecraft does. Admin rights are the admin
 * password: whoever types `enablecheats <password>` at the console is an admin
 * until they log out, which means administering a server means handing the
 * password around, and taking it back from one person means changing it for
 * everybody.
 *
 * The one alternative the game ships is a file - `AllowedCheaterSteamIDs.txt` in
 * the save folder - listing the Steam ids that get those rights without the
 * password and without typing anything. That is the closest thing ARK has to
 * making somebody an operator, so it is what the Players screen offers, and it is
 * genuinely better than the password: it is per person, it is revocable, and
 * nobody has to be told a secret.
 *
 * The file is read when the server starts and not again, which the screen says
 * out loud - a name added here while the server is up is an admin from the next
 * start, not from the next time they join.
 *
 * Pure: the parsing and the two edits, so the screen and the action agree about
 * what the file holds.
 */

/** Where the game looks, relative to the server's own root inside the container. */
export const ADMIN_LIST_PATH = "ShooterGame/Saved/AllowedCheaterSteamIDs.txt";

/** A SteamID64, which is the only thing this file may contain. */
const STEAM_ID_64 = /^7656119\d{10}$/;

/** Enough for any server's staff, and a ceiling so a corrupt read cannot become a
 *  file with a million lines in it. */
export const MAX_ADMINS = 200;

/**
 * The ids in the file, in the order it holds them.
 *
 * Anything that is not a Steam id is dropped rather than kept: the file is
 * hand-edited on plenty of servers and may hold comments, blank lines or a
 * Windows line ending, and none of those are a person to show in a list.
 */
export function parseAdminList(content: string): string[] {
    const ids: string[] = [];
    for (const line of content.split(/\r?\n/)) {
        const value = line.trim();
        if (!STEAM_ID_64.test(value) || ids.includes(value)) continue;
        ids.push(value);
    }
    return ids.slice(0, MAX_ADMINS);
}

/** The file as it should be written back. A trailing newline, because the file is
 *  read line by line and an editor that appends to it should not join two ids. */
export function formatAdminList(ids: readonly string[]): string {
    return ids.length === 0 ? "" : `${ids.join("\n")}\n`;
}

/** The list with one more admin on it, or unchanged when they already are one. */
export function withAdmin(ids: readonly string[], steamId: string): string[] {
    if (!STEAM_ID_64.test(steamId)) throw new Error("That is not a Steam id");
    if (ids.includes(steamId)) return [...ids];
    if (ids.length >= MAX_ADMINS) throw new Error(`Only ${MAX_ADMINS} admins can be listed`);
    return [...ids, steamId];
}

export function withoutAdmin(ids: readonly string[], steamId: string): string[] {
    return ids.filter((id) => id !== steamId);
}
