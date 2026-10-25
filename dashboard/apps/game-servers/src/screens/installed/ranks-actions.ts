"use server";

/**
 * The Ranks tab: the symbol, tag and colour in front of players' names.
 *
 * Gated on the console grant, like the tab, because a rank is sent to the server
 * as console commands and anybody who can type those can make the same teams by
 * hand; holding the ranks to a lower grant would make them a way around it.
 * Saving and importing are rate limited and written to the audit.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import * as service from "../../lib/minecraft/ranks-service";
import { gameWords, issueText, messageText } from "../game-words";
import { ranksSchema, type Rank } from "../../lib/minecraft/ranks";
import { editionOf, type MinecraftEdition } from "../../lib/minecraft/service";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

/** Saves and imports one person may make in a minute. Far more than anybody
 *  editing by hand, and few enough that a loop cannot flood the server. */
const RANK_WRITES_PER_MINUTE = 10;

const serverId = z.string().uuid();

const failure = async (caught: unknown, fallback: string): Promise<string> =>
    caught instanceof Error ? await messageText(caught.message) : fallback;

async function allowed(userId: string): Promise<boolean> {
    const result = await host.rateLimitService
        .rateLimit(`games-ranks:${userId}`, RANK_WRITES_PER_MINUTE, 60_000)
        .catch(() => ({ ok: true }));
    return result.ok;
}

export interface RanksView {
    readonly ranks: readonly Rank[];
    readonly edition: MinecraftEdition;
}

export async function readRanksAction(
    installedAppId: string
): Promise<{ view?: RanksView; error?: string }> {
    const words = await gameWords("minecraft");
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.console", parsed.data);
        const state = await service.readServerRanks(parsed.data);
        return { view: { ranks: state.ranks, edition: editionOf(access.install.catalogId) } };
    } catch (caught) {
        return { error: await failure(caught, words("ranks.readFailed")) };
    }
}

const saveInput = z.object({ installedAppId: serverId, ranks: ranksSchema });

export interface RanksSaved {
    readonly ranks: readonly Rank[];
    readonly applied: boolean;
    readonly refused: number;
}

/** Store the ranks and apply them to the server, or keep them for its next start. */
export async function saveRanksAction(input: {
    installedAppId: string;
    ranks: unknown;
}): Promise<{ saved?: RanksSaved; error?: string }> {
    const words = await gameWords("minecraft");
    const parsed = saveInput.safeParse(input);
    if (!parsed.success) {
        return {
            error: (await issueText(parsed.error.issues[0]?.message)) ?? words("ranks.saveFailed")
        };
    }
    try {
        const { user, access } = await requireGameServer(
            "games.console",
            parsed.data.installedAppId
        );
        if (!(await allowed(user.id))) return { error: words("ranks.rateLimited") };
        const result = await service.saveRanks(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.ranks
        );
        await recordAudit({
            actorId: user.id,
            action: "minecraft.ranks.save",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: {
                ranks: String(parsed.data.ranks.length),
                applied: String(result.applied),
                refused: String(result.refused)
            }
        });
        const state = await service.readServerRanks(parsed.data.installedAppId);
        return { saved: { ranks: state.ranks, applied: result.applied, refused: result.refused } };
    } catch (caught) {
        return { error: await failure(caught, words("ranks.saveFailed")) };
    }
}

/** The server's own teams as ranks to edit. Changes nothing on the server. */
export async function importRanksAction(
    installedAppId: string
): Promise<{ ranks?: Rank[]; error?: string }> {
    const words = await gameWords("minecraft");
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { user, access } = await requireGameServer("games.console", parsed.data);
        const applicationId = access.install.applicationId;
        if (!applicationId)
            return { error: (await gameWords("games"))("errors.thisServerHasNotBeen") };
        if (!(await allowed(user.id))) return { error: words("ranks.rateLimited") };
        const ranks = await service.importServerTeams(access.ownerId, parsed.data, applicationId);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.ranks.import",
            targetType: "installedApp",
            targetId: parsed.data,
            metadata: { teams: String(ranks.length) }
        });
        return { ranks };
    } catch (caught) {
        return { error: await failure(caught, words("ranks.importFailed")) };
    }
}
