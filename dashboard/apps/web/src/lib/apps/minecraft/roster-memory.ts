/**
 * The last roster a server gave, kept so its screen is not blank while it is off.
 *
 * Everything on the moderation screen - who is an operator, who is on the
 * whitelist, who is banned, and whether the whitelist is being enforced at all -
 * is read out of files inside the container. A stopped server has no container to
 * read, so the screen had nothing: no names, and a whitelist switch drawn as off
 * because the absence of an answer and "the whitelist is off" arrived looking
 * identical. That is the opposite of the truth for the ordinary Polaris server,
 * which is closed by default and lets nobody in who is not on the list.
 *
 * So the answer is written down whenever the server gives one, and handed back
 * when it will not. Nothing here makes anything changeable: the screen gates its
 * controls on whether the server is answering, not on whether it has a roster, so
 * a remembered one is something to look at and never something that appears to be
 * editable.
 *
 * Kept in the install's own config blob, which is the game-servers app's store
 * rather than Polaris's - it goes when the install does.
 */

import { prisma } from "@polaris/db";
import type { BanEntry } from "./parse";
import type { MinecraftRoster } from "./service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";

const REMEMBERED_KEY = "minecraftRoster";

export interface RememberedRoster {
    readonly roster: MinecraftRoster;
    /** When the server gave it, as an ISO instant. */
    readonly at: string;
}

/** Player names out of a stored list. Anything that is not a string is dropped
 *  rather than drawn: this is a JSON column, and an older Polaris - or somebody
 *  editing it - is not a reason for a screen to fail to open. */
function names(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** Bans out of a stored list, with the two nullable halves normalised back. */
function bans(value: unknown): BanEntry[] {
    if (!Array.isArray(value)) return [];
    const found: BanEntry[] = [];
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) continue;
        const held = entry as { name?: unknown; reason?: unknown; source?: unknown };
        if (typeof held.name !== "string" || !held.name) continue;
        found.push({
            name: held.name,
            reason: typeof held.reason === "string" ? held.reason : null,
            source: typeof held.source === "string" ? held.source : null
        });
    }
    return found;
}

/** What this server last said about who may play on it, or null when it has
 *  never said. */
export async function rememberedRoster(installedAppId: string): Promise<RememberedRoster | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    const stored = readInstallConfig(row?.config)[REMEMBERED_KEY];
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
    const blob = stored as { roster?: unknown; at?: unknown };
    const at = typeof blob.at === "string" && Number.isFinite(Date.parse(blob.at)) ? blob.at : null;
    if (!at || typeof blob.roster !== "object" || blob.roster === null) return null;

    const held = blob.roster as {
        ops?: unknown;
        whitelist?: unknown;
        bans?: unknown;
        whitelistEnforced?: unknown;
    };
    return {
        at,
        roster: {
            ops: names(held.ops),
            whitelist: names(held.whitelist),
            bans: bans(held.bans),
            // Only a stored `true` is enforcement. Anything else - a missing
            // field, a value an older Polaris never wrote - is the same answer
            // the server gives for a whitelist that is off.
            whitelistEnforced: held.whitelistEnforced === true
        }
    };
}

/** Keep what the server just said. Never worth failing a poll over: this is a
 *  note about the answer, not the answer. */
export async function rememberRoster(installedAppId: string, roster: MinecraftRoster): Promise<void> {
    await patchInstallConfig(installedAppId, {
        [REMEMBERED_KEY]: {
            at: new Date().toISOString(),
            roster: {
                ops: [...roster.ops],
                whitelist: [...roster.whitelist],
                bans: roster.bans.map((ban) => ({
                    name: ban.name,
                    reason: ban.reason,
                    source: ban.source
                })),
                whitelistEnforced: roster.whitelistEnforced
            }
        }
    });
}
