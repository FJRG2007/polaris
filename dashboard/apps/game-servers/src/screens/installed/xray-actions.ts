"use server";

/**
 * Anti X-Ray and the movement watch: the settings, the evidence and the mining
 * figures behind it. The scores are worked out from these on the screen, by the
 * same pure function the tests hold (`suspicion.ts`).
 *
 * Reading the evidence is the moderators'; turning the honeypots on or off and
 * choosing what happens automatically is the managers'. Clearing a player is a
 * moderator's call, since it is the same judgement as deciding they cheated.
 */

import { z } from "zod";
import { gameWords, issueText, messageText } from "../game-words";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { editionOf, onlinePlayers } from "../../lib/minecraft/service";
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
import { countingIncidents, type Incident } from "../../lib/minecraft/movement";
import {
    clearEngineFlags,
    engineRecords,
    type EngineRecord
} from "../../lib/minecraft/polaris-anticheat-service";
import { moddedServer } from "../../lib/minecraft/polaris-anticheat";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;
const { readInstallConfig } = host.appsInstallConfig;
const { listEnvVars } = host.envVarService;

export interface XrayPlayer {
    readonly name: string;
    readonly verdict: Verdict;
    readonly hits: readonly Hit[];
    readonly warnedAt: number | null;
    readonly bannedAt: number | null;
}

export interface MovementPlayer {
    readonly name: string;
    readonly incidents: readonly Incident[];
}

export interface XrayView {
    readonly settings: XraySettings;
    /** Honeypots in place, by dimension. */
    readonly traps: { readonly overworld: number; readonly nether: number };
    readonly players: readonly XrayPlayer[];
    readonly mining: readonly PlayerMining[];
    /** Who is online now, listed whether or not anything was found. */
    readonly online: readonly string[];
    /** Flying and teleport incidents that still count, per player. */
    readonly movement: readonly MovementPlayer[];
    /** Why teleports are not being checked right now, or null while they are. */
    readonly teleportCheck: string | null;
    /** Why this server cannot have honeypots, or null. */
    readonly refusal: string | null;
    /** What Polaris's anti-cheat engine caught, per player, in the window. */
    readonly engine: readonly EngineRecord[];
    /** Whether the server runs mods, where the engine's movement and block
     *  checks are approximate. Missing from a view kept before it was read. */
    readonly modded?: boolean;
}

async function viewOf(
    ownerId: string,
    installedAppId: string,
    withMining: boolean
): Promise<XrayView> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, catalogId: true, applicationId: true }
    });
    const state = readXray(readInstallConfig(row?.config));
    const now = Date.now();
    const bedrock = editionOf(row?.catalogId ?? "minecraft") === "bedrock";
    // Four trips - the stats files and the player list into the container, the
    // engine's alerts and the server's software to the database - that do not
    // wait on each other.
    const [mining, online, engine, modded] = await Promise.all([
        withMining && !bedrock ? readAllMining(ownerId, installedAppId) : [],
        onlinePlayers(ownerId, installedAppId)
            .then((answer) => answer?.players ?? [])
            .catch(() => []),
        bedrock ? [] : engineRecords(installedAppId).catch(() => []),
        row?.applicationId
            ? listEnvVars("application", row.applicationId, ownerId)
                  .then((vars) =>
                      moddedServer(new Map(vars.map((one) => [one.key, one.value ?? ""])))
                  )
                  .catch(() => false)
            : false
    ]);
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
        mining,
        online,
        movement: Object.values(state.movement)
            .map((evidence) => ({
                name: evidence.name,
                incidents: countingIncidents(evidence, now)
            }))
            .filter((player) => player.incidents.length > 0),
        teleportCheck: state.settings.movement ? state.teleportCheck : null,
        refusal: bedrock ? (await gameWords("games"))("errors.bedrockKeepsNoPerPlayer") : null,
        engine,
        modded
    };
}

const idSchema = z.string().uuid();

export async function readXrayAction(
    installedAppId: string
): Promise<{ view?: XrayView; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.thatServerIsNotHere") };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data);
        return { view: await viewOf(access.ownerId, parsed.data, true) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCouldNotBeRead")
        };
    }
}

const saveSchema = z.object({ installedAppId: z.string().uuid(), settings: xraySettingsSchema });

export async function saveXraySettingsAction(
    input: z.input<typeof saveSchema>
): Promise<{ view?: XrayView; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                (await gameWords("games"))("errors.checkTheSettings")
        };
    const { installedAppId, settings } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, catalogId: true }
        });
        if (editionOf(row?.catalogId ?? "minecraft") === "bedrock") {
            return { error: (await gameWords("games"))("errors.bedrockKeepsNoPerPlayer") };
        }
        const saved = await updateXray(installedAppId, (state) => ({ ...state, settings }));
        if (!saved) return { error: (await gameWords("games"))("errors.thatServerIsNotHere") };
        // On or off, the loop does the work: placing honeypots, or putting the
        // rock back where they were.
        startXrayTraps(access.ownerId, installedAppId);
        await recordAudit({
            actorId: user.id,
            action: "games.xray.settings",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: {
                enabled: settings.enabled,
                action: settings.action,
                movement: settings.movement
            }
        });
        return { view: await viewOf(access.ownerId, installedAppId, false) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCouldNotBeSaved")
        };
    }
}

const clearSchema = z.object({
    installedAppId: z.string().uuid(),
    player: z.string().trim().min(1).max(40)
});

/** Forget a player's evidence - honeypots, movement and the anti-cheat engine's
 *  flags alike: the moderator looked and decided it was not cheating. */
export async function clearXrayPlayerAction(
    input: z.input<typeof clearSchema>
): Promise<{ view?: XrayView; error?: string }> {
    const parsed = clearSchema.safeParse(input);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.chooseAPlayer") };
    const { installedAppId, player } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.moderate", installedAppId);
        const key = player.toLowerCase();
        const cleared = await updateXray(installedAppId, (state) => {
            const { [key]: _, ...evidence } = state.evidence;
            const { [key]: __, ...movement } = state.movement;
            return { ...state, evidence, movement };
        });
        if (!cleared) return { error: (await gameWords("games"))("errors.thatServerIsNotHere") };
        await clearEngineFlags(installedAppId, player);
        await recordAudit({
            actorId: user.id,
            action: "games.xray.clear",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player }
        });
        return { view: await viewOf(access.ownerId, installedAppId, false) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCouldNotBeCleared")
        };
    }
}
