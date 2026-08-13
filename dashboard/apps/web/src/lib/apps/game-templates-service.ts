/**
 * Saving a built server as something to build again, and reading those back.
 *
 * The saving is where the care is. A template is the *difference* between the
 * server as it stands and a fresh one built the same way, so this builds that
 * fresh one's environment - without deploying anything - and compares. See
 * `game-templates.ts` for why the difference rather than the whole thing.
 */

import { prisma } from "@polaris/db";
import { listEnvVars } from "@/lib/env-var-service";
import { gameOfServer } from "@/lib/apps/games-catalog";
import { readInstallConfig } from "@/lib/apps/install-config";
import { hasCrossplay } from "@/lib/apps/minecraft/blueprints";
import { BLUEPRINT_KEY, MAP_KEY, RELEASE_KEY, blueprintFor, minecraftShapeEnv } from "@/lib/apps/games-create";
import {
    readTemplateSettings,
    templateSettings,
    type ServerTemplateView
} from "@/lib/apps/game-templates";

/** How many somebody may keep. Enough for a shelf of them, short of a list that is
 *  itself a thing to manage. */
const TEMPLATE_LIMIT = 40;

/** Everything this person has saved, newest first. */
export async function listServerTemplates(ownerId: string, game?: string): Promise<ServerTemplateView[]> {
    const rows = await prisma.serverTemplate
        .findMany({
            where: { ownerId, ...(game ? { game } : {}) },
            orderBy: { createdAt: "desc" },
            take: TEMPLATE_LIMIT
        })
        .catch(() => []);
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        summary: row.summary,
        game: row.game,
        edition: row.edition,
        blueprintId: row.blueprintId,
        mapId: row.mapId,
        version: row.version,
        concurrentPlayers: row.concurrentPlayers,
        crossplay: row.crossplay,
        settings: Object.keys(readTemplateSettings(row.env)).length,
        createdAt: row.createdAt.toISOString()
    }));
}

/** The settings a template carries, for the create that is about to apply them. */
export async function readServerTemplate(
    ownerId: string,
    id: string
): Promise<{ view: ServerTemplateView; settings: Record<string, string> } | null> {
    const row = await prisma.serverTemplate.findFirst({ where: { id, ownerId } }).catch(() => null);
    if (!row) return null;
    const settings = readTemplateSettings(row.env);
    return {
        view: {
            id: row.id,
            name: row.name,
            summary: row.summary,
            game: row.game,
            edition: row.edition,
            blueprintId: row.blueprintId,
            mapId: row.mapId,
            version: row.version,
            concurrentPlayers: row.concurrentPlayers,
            crossplay: row.crossplay,
            settings: Object.keys(settings).length,
            createdAt: row.createdAt.toISOString()
        },
        settings
    };
}

/**
 * Write down how this server is built.
 *
 * What it captures is worked out rather than copied: the same shaping the create
 * screen would do for a fresh server of this kind is run here, in memory and
 * against nothing, and only the values that came out different are kept.
 */
export async function saveServerAsTemplate(
    ownerId: string,
    installedAppId: string,
    name: string,
    summary: string
): Promise<{ id?: string; error?: string }> {
    const install = await prisma.installedApp
        .findFirst({
            where: { id: installedAppId, ownerId, status: { not: "removed" } },
            select: { applicationId: true, catalogId: true, config: true }
        })
        .catch(() => null);
    if (!install?.applicationId) return { error: "This server has not been deployed yet" };

    const kept = await prisma.serverTemplate.count({ where: { ownerId } }).catch(() => 0);
    if (kept >= TEMPLATE_LIMIT) return { error: `You can keep ${TEMPLATE_LIMIT} templates. Delete one first.` };

    const game = gameOfServer(install.catalogId)?.id ?? "minecraft";
    const config = readInstallConfig(install.config);
    const blueprintId = typeof config[BLUEPRINT_KEY] === "string" ? (config[BLUEPRINT_KEY] as string) : "survival";
    const mapId = typeof config[MAP_KEY] === "string" ? (config[MAP_KEY] as string) : "";
    const version = typeof config[RELEASE_KEY] === "string" ? (config[RELEASE_KEY] as string) : "LATEST";

    const vars = await listEnvVars("application", install.applicationId, ownerId).catch(() => []);
    const built = new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
    const edition = install.catalogId.includes("bedrock") ? "bedrock" : "java";
    const crossplay = hasCrossplay(built.get("MODRINTH_PROJECTS"));
    const players = Number(built.get("MAX_PLAYERS")) || 8;

    // What a fresh one of this kind would be given. Built here and thrown away -
    // nothing is deployed, nothing is written - purely so the two can be compared.
    let fresh = new Map<string, string>();
    if (game !== "ark") {
        fresh = await minecraftShapeEnv(
            edition,
            blueprintFor(edition, blueprintId),
            {
                blueprintId,
                ...(mapId ? { mapId } : {}),
                version,
                concurrentPlayers: players,
                crossplay
            },
            new Map()
        ).catch(() => new Map<string, string>());
    }

    const settings = templateSettings(built, fresh);
    const row = await prisma.serverTemplate
        .create({
            data: {
                ownerId,
                name: name.trim(),
                summary: summary.trim().slice(0, 200),
                game,
                edition,
                blueprintId,
                mapId,
                version,
                env: JSON.stringify(settings),
                concurrentPlayers: players,
                crossplay
            }
        })
        .catch(() => null);
    return row ? { id: row.id } : { error: "You already have a template with that name" };
}

export async function deleteServerTemplate(ownerId: string, id: string): Promise<void> {
    await prisma.serverTemplate.deleteMany({ where: { id, ownerId } }).catch(() => undefined);
}
