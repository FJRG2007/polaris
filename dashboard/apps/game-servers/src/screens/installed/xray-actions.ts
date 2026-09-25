"use server";

/**
 * Anti X-Ray: the settings, the evidence and the mining figures behind it.
 *
 * Reading the evidence is the moderators'; turning the honeypots on or off and
 * choosing what happens automatically is the managers'. Clearing a player is a
 * moderator's call, since it is the same judgement as deciding they cheated.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { editionOf } from "../../lib/minecraft/service";
import { startXrayTraps, updateXray } from "../../lib/minecraft/xray-service";
import { readAllMining, type PlayerMining } from "../../lib/minecraft/stats-service";
import {
    countingHits,
    readXray,
    verdictOf,
    xraySettingsSchema,
    type Hit,
    type Verdict,
    type XraySettings
} from "../../lib/minecraft/xray";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;
const { readInstallConfig } = host.appsInstallConfig;

export interface XrayPlayer {
    readonly name: string;
    readonly verdict: Verdict;
    readonly hits: readonly Hit[];
    readonly warnedAt: number | null;
    readonly bannedAt: number | null;
}

export interface XrayView {
    readonly settings: XraySettings;
    /** Honeypots in place, by dimension. */
    readonly traps: { readonly overworld: number; readonly nether: number };
    readonly players: readonly XrayPlayer[];
    readonly mining: readonly PlayerMining[];
    /** Why this server cannot have honeypots, or null. */
    readonly refusal: string | null;
}

async function viewOf(
    ownerId: string,
    installedAppId: string,
    withMining: boolean
): Promise<XrayView> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, catalogId: true }
    });
    const state = readXray(readInstallConfig(row?.config));
    const now = Date.now();
    const bedrock = editionOf(row?.catalogId ?? "minecraft") === "bedrock";
    return {
        settings: state.settings,
        traps: {
            overworld: state.honeypots.filter((trap) => trap.dimension === "minecraft:overworld")
                .length,
            nether: state.honeypots.filter((trap) => trap.dimension === "minecraft:the_nether")
                .length
        },
        players: Object.values(state.evidence)
            .map((evidence) => ({
                name: evidence.name,
                verdict: verdictOf(evidence, now),
                hits: countingHits(evidence, now),
                warnedAt: evidence.warnedAt,
                bannedAt: evidence.bannedAt
            }))
            .filter((player) => player.hits.length > 0)
            .sort((left, right) => right.hits.length - left.hits.length),
        mining: withMining && !bedrock ? await readAllMining(ownerId, installedAppId) : [],
        refusal: bedrock ? "Bedrock keeps no per-player mining counters Polaris can watch" : null
    };
}

const idSchema = z.string().uuid();

export async function readXrayAction(
    installedAppId: string
): Promise<{ view?: XrayView; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: "That server is not here" };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data);
        return { view: await viewOf(access.ownerId, parsed.data, true) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That could not be read" };
    }
}

const saveSchema = z.object({ installedAppId: z.string().uuid(), settings: xraySettingsSchema });

export async function saveXraySettingsAction(
    input: z.input<typeof saveSchema>
): Promise<{ view?: XrayView; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings" };
    const { installedAppId, settings } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, catalogId: true }
        });
        if (editionOf(row?.catalogId ?? "minecraft") === "bedrock") {
            return { error: "Bedrock keeps no per-player mining counters Polaris can watch" };
        }
        const saved = await updateXray(installedAppId, (state) => ({ ...state, settings }));
        if (!saved) return { error: "That server is not here" };
        // On or off, the loop does the work: placing honeypots, or putting the
        // rock back where they were.
        startXrayTraps(access.ownerId, installedAppId);
        await recordAudit({
            actorId: user.id,
            action: "games.xray.settings",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { enabled: settings.enabled, action: settings.action }
        });
        return { view: await viewOf(access.ownerId, installedAppId, false) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That could not be saved" };
    }
}

const clearSchema = z.object({
    installedAppId: z.string().uuid(),
    player: z.string().trim().min(1).max(40)
});

/** Forget a player's evidence: the moderator looked and decided it was not cheating. */
export async function clearXrayPlayerAction(
    input: z.input<typeof clearSchema>
): Promise<{ view?: XrayView; error?: string }> {
    const parsed = clearSchema.safeParse(input);
    if (!parsed.success) return { error: "Choose a player" };
    const { installedAppId, player } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        const key = player.toLowerCase();
        const cleared = await updateXray(installedAppId, (state) => {
            const { [key]: _, ...evidence } = state.evidence;
            return { ...state, evidence };
        });
        if (!cleared) return { error: "That server is not here" };
        await recordAudit({
            actorId: user.id,
            action: "games.xray.clear",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player }
        });
        return { view: await viewOf(access.ownerId, installedAppId, false) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That could not be cleared" };
    }
}
