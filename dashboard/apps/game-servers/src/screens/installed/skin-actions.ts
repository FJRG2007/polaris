"use server";

/**
 * A player's skin: reading what they wear (`games.read`), and changing or taking
 * it off (`games.moderate`) - the same standing the inventory takes, recorded
 * like every other change made to a player.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import * as skin from "../../lib/minecraft/skin";
import { gameMessage, readGameMessage } from "../../lib/game-message";
import { gameWords, messageText } from "../game-words";
import * as service from "../../lib/minecraft/skin-service";
import { withServerContainer } from "../../lib/minecraft/service";

const { recordAudit } = host.auditService;
const { rateLimit } = host.rateLimitService;
const { requireGameServer } = host.appsInstallAccess;

const playerName = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,16}$/);

/** Base64 of at most a skin's worth of bytes. */
const pngData = z
    .string()
    .max(Math.ceil(skin.SKIN_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);

const signedSchema = z.object({
    value: z.string().max(4096),
    signature: z.string().max(4096)
});

/**
 * Who may change a player's skin: whoever moderates the server, and the person
 * that player is - a Polaris account linked to the name (`GamePlayerLink`) - who
 * may only read the server otherwise. A skin is how somebody looks to everybody
 * else, so it is theirs to pick; anyone else's stays a moderator's call.
 */
async function requireSkinEditor(installedAppId: string, player: string | null) {
    try {
        return await requireGameServer("games.moderate", installedAppId);
    } catch {
        const resolved = await requireGameServer("games.read", installedAppId);
        if (!player || !(await isLinkedTo(installedAppId, player, resolved.user.id))) {
            throw new Error(gameMessage("minecraft", "skins.onlyYourOwn"));
        }
        return resolved;
    }
}

async function isLinkedTo(
    installedAppId: string,
    player: string,
    userId: string
): Promise<boolean> {
    const link = await prisma.gamePlayerLink.findFirst({
        where: { installedAppId, userId, player: { equals: player, mode: "insensitive" } },
        select: { id: true }
    });
    return link !== null;
}

/** Looks up and signings go out to other services: a few a minute per person. */
const LOOKUPS_PER_MINUTE = 20;
const SIGNINGS_PER_MINUTE = 4;

async function failureText(caught: unknown, fallback: string): Promise<string> {
    const t = await gameWords("minecraft");
    if (caught instanceof service.SkinError)
        return caught.failure === "signingBusy" && caught.retryAfterSeconds
            ? t("skins.failures.signingBusyFor", { seconds: caught.retryAfterSeconds })
            : t(`skins.failures.${caught.failure}`);
    return caught instanceof Error && readGameMessage(caught.message)
        ? await messageText(caught.message)
        : t(fallback as never);
}

/** What a player wears now, as the server says. */
export async function readSkinAction(input: {
    installedAppId: string;
    player: string;
}): Promise<{ live?: service.LiveSkin; ownSkin?: boolean; error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), player: playerName })
        .safeParse(input);
    const t = await gameWords("minecraft");
    if (!parsed.success) return { error: t("errors.checkTheDetailsAndTry") };
    try {
        const { user, access } = await requireGameServer("games.read", parsed.data.installedAppId);
        const live = await withServerContainer(
            access.ownerId,
            parsed.data.installedAppId,
            (server) => service.readLiveSkin(server, parsed.data.player)
        );
        return {
            live,
            ownSkin: await isLinkedTo(parsed.data.installedAppId, parsed.data.player, user.id)
        };
    } catch (caught) {
        return { error: await failureText(caught, "skins.couldNotRead") };
    }
}

const previewSchema = z.union([
    z.object({
        installedAppId: z.string().uuid(),
        player: playerName.optional(),
        kind: z.literal("file"),
        png: pngData,
        fileName: z.string().max(255)
    }),
    z.object({
        installedAppId: z.string().uuid(),
        player: playerName.optional(),
        kind: z.literal("text"),
        text: z.string().trim().min(1).max(2048)
    })
]);

/** A skin from a file, a link, a texture or a player name, ready to show. */
export async function previewSkinAction(input: z.input<typeof previewSchema>): Promise<{
    png?: string;
    model?: skin.SkinModel;
    signed?: skin.SignedSkin | null;
    error?: string;
}> {
    const parsed = previewSchema.safeParse(input);
    const t = await gameWords("minecraft");
    if (!parsed.success) return { error: t("errors.checkTheDetailsAndTry") };
    try {
        const { user } = await requireSkinEditor(
            parsed.data.installedAppId,
            parsed.data.player ?? null
        );
        if (parsed.data.kind === "text") {
            const allowed = await rateLimit(`skin-lookup:${user.id}`, LOOKUPS_PER_MINUTE, 60_000);
            if (!allowed.ok) return { error: t("skins.failures.tooMany") };
        }
        const preview = await service.resolveSource(
            parsed.data.kind === "file"
                ? {
                      kind: "file",
                      bytes: new Uint8Array(Buffer.from(parsed.data.png, "base64")),
                      model: skin.modelFromFileName(parsed.data.fileName)
                  }
                : { kind: "text", text: parsed.data.text }
        );
        return {
            png: Buffer.from(preview.png).toString("base64"),
            model: preview.model,
            signed: preview.signed
        };
    } catch (caught) {
        return { error: await failureText(caught, "skins.couldNotLoad") };
    }
}

const applySchema = z.object({
    installedAppId: z.string().uuid(),
    player: playerName,
    png: pngData,
    model: z.enum(skin.SKIN_MODELS),
    /** The signed value that came with the preview, used while the model is its own. */
    signed: signedSchema.nullable()
});

/**
 * Put a skin on a player. A value signed for this model is used as it is;
 * anything else is signed first, since an unsigned skin shows to nobody else.
 */
export async function applySkinAction(
    input: z.input<typeof applySchema>
): Promise<{ live?: service.LiveSkin; error?: string }> {
    const parsed = applySchema.safeParse(input);
    const t = await gameWords("minecraft");
    if (!parsed.success) return { error: t("errors.checkTheDetailsAndTry") };
    const { installedAppId, player, model } = parsed.data;
    try {
        const { user, access } = await requireSkinEditor(installedAppId, player);
        const given = parsed.data.signed ? skin.signedSkin(parsed.data.signed) : null;
        let signed = given && skin.decodeSkinValue(given.value)?.model === model ? given : null;
        if (!signed) {
            const allowed = await rateLimit(`skin-sign:${user.id}`, SIGNINGS_PER_MINUTE, 60_000);
            if (!allowed.ok) return { error: t("skins.failures.tooMany") };
            signed = await service.signPng(
                new Uint8Array(Buffer.from(parsed.data.png, "base64")),
                model
            );
        }
        const live = await withServerContainer(access.ownerId, installedAppId, (server) =>
            service.applySkin(server, player, signed)
        );
        if (live.state === "unsupported") return { live, error: t("skins.needsUpdate") };
        await recordAudit({
            actorId: user.id,
            action: "minecraft.skin-apply",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player, model, hash: skin.decodeSkinValue(signed.value)?.hash ?? null }
        });
        return { live };
    } catch (caught) {
        return { error: await failureText(caught, "skins.couldNotApply") };
    }
}

/** Take a player's skin off, back to their account's own. */
export async function clearSkinAction(input: {
    installedAppId: string;
    player: string;
}): Promise<{ live?: service.LiveSkin; error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), player: playerName })
        .safeParse(input);
    const t = await gameWords("minecraft");
    if (!parsed.success) return { error: t("errors.checkTheDetailsAndTry") };
    const { installedAppId, player } = parsed.data;
    try {
        const { user, access } = await requireSkinEditor(installedAppId, player);
        const live = await withServerContainer(access.ownerId, installedAppId, (server) =>
            service.clearSkin(server, player)
        );
        if (live.state === "unsupported") return { live, error: t("skins.needsUpdate") };
        await recordAudit({
            actorId: user.id,
            action: "minecraft.skin-clear",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { player }
        });
        return { live };
    } catch (caught) {
        return { error: await failureText(caught, "skins.couldNotApply") };
    }
}
