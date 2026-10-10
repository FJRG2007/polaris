"use server";

/**
 * A server's Sounds tab: the library, what the server does with it, and the
 * live state of the pack on the players' side.
 *
 * Reading is for anybody who can see the server; changing the library or the
 * settings is its managers'; playing a sound to the players is the console's,
 * like an announcement. Every change that the players' pack depends on is
 * followed by telling a running server to hand the new one out.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { gameWords, messageText } from "../game-words";
import { editionOf } from "../../lib/minecraft/service";
import * as service from "../../lib/minecraft/sounds-service";
import { MAX_PITCH, MIN_PITCH } from "../../lib/minecraft/sounds";

const { recordAudit } = host.auditService;
const { deployApplication } = host.deployService;
const { requireGameServer } = host.appsInstallAccess;

const serverId = z.string().uuid();

async function failure(caught: unknown): Promise<string> {
    const digest = (caught as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_")) throw caught;
    if (caught instanceof service.SoundRefusal) return messageText(caught.message);
    if (caught instanceof Error && caught.message === "Server not found")
        return (await gameWords("games"))("errors.serverNotFound");
    console.error("[minecraft-sounds] action failed:", caught);
    return (await gameWords("minecraft"))("sounds.refused.failed");
}

export interface SoundsView {
    readonly library: service.SoundLibrary;
    readonly delivery: service.SoundsDelivery;
}

export async function soundsAction(
    installedAppId: string
): Promise<{ view?: SoundsView; error?: string }> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.read", parsed.data);
        const applicationId = access.install.applicationId;
        if (!applicationId)
            return { error: (await gameWords("games"))("errors.thisServerHasNotBeen") };
        const [library, delivery] = await Promise.all([
            service.soundLibrary(parsed.data),
            service.soundsDelivery(
                parsed.data,
                applicationId,
                access.ownerId,
                editionOf(access.install.catalogId)
            )
        ]);
        return { view: { library, delivery } };
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

export async function liveSoundsAction(
    installedAppId: string
): Promise<{ live?: service.LiveSounds; error?: string }> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.read", parsed.data);
        return { live: await service.liveSounds(access.ownerId, parsed.data) };
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

const changeSchema = z.object({
    installedAppId: serverId,
    soundId: z.string().uuid(),
    name: z.string().max(200).optional(),
    subtitle: z.string().max(200).optional(),
    stream: z.boolean().optional(),
    replaces: z.string().max(200).optional()
});

export async function updateSoundAction(
    input: z.input<typeof changeSchema>
): Promise<{ error?: string; pushed?: boolean }> {
    const parsed = changeSchema.safeParse(input);
    if (!parsed.success)
        return { error: (await gameWords("minecraft"))("sounds.refused.settings") };
    try {
        const { user, access } = await requireGameServer(
            "games.manage",
            parsed.data.installedAppId
        );
        const { installedAppId, soundId, ...change } = parsed.data;
        await service.updateSound(installedAppId, soundId, change);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.sounds.edit",
            targetType: "installedApp",
            targetId: installedAppId
        });
        return { pushed: await service.refreshServer(access.ownerId, installedAppId) };
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

const removeSchema = z.object({ installedAppId: serverId, soundId: z.string().uuid() });

export async function deleteSoundAction(
    input: z.input<typeof removeSchema>
): Promise<{ error?: string; pushed?: boolean }> {
    const parsed = removeSchema.safeParse(input);
    if (!parsed.success) return { error: (await gameWords("minecraft"))("sounds.refused.gone") };
    try {
        const { user, access } = await requireGameServer(
            "games.manage",
            parsed.data.installedAppId
        );
        await service.deleteSound(parsed.data.installedAppId, parsed.data.soundId);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.sounds.delete",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        return { pushed: await service.refreshServer(access.ownerId, parsed.data.installedAppId) };
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

export async function saveSoundSettingsAction(input: {
    installedAppId: string;
    settings: unknown;
}): Promise<{ error?: string; pushed?: boolean }> {
    const parsed = serverId.safeParse(input.installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data);
        const saved = await service.saveSoundSettings(parsed.data, input.settings);
        if (access.install.applicationId)
            await service.syncServerPackRequired(
                parsed.data,
                access.install.applicationId,
                access.ownerId,
                saved.required
            );
        await recordAudit({
            actorId: user.id,
            action: "minecraft.sounds.settings",
            targetType: "installedApp",
            targetId: parsed.data
        });
        return { pushed: await service.refreshServer(access.ownerId, parsed.data) };
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

const playSchema = z.object({
    installedAppId: serverId,
    key: z.string().regex(/^[a-z0-9_]{1,40}$/),
    player: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_]{1,16}$/)
        .nullable(),
    volume: z.number().finite().min(0).max(1),
    pitch: z.number().finite().min(MIN_PITCH).max(MAX_PITCH)
});

export async function playSoundAction(
    input: z.input<typeof playSchema>
): Promise<{ error?: string }> {
    const parsed = playSchema.safeParse(input);
    if (!parsed.success) return { error: (await gameWords("minecraft"))("sounds.refused.player") };
    try {
        const { access } = await requireGameServer("games.console", parsed.data.installedAppId);
        const { installedAppId, ...play } = parsed.data;
        await service.playSound(access.ownerId, installedAppId, play);
        return {};
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

/** Hand the pack out again to everybody on, now. */
export async function pushSoundsAction(
    installedAppId: string
): Promise<{ error?: string; pushed?: boolean }> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.manage", parsed.data);
        return { pushed: await service.refreshServer(access.ownerId, parsed.data) };
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

/** Put Polaris's jar on the server so the pack reaches players live, and
 *  restart it onto the jar when it was not there. */
export async function enableSoundsAction(
    installedAppId: string
): Promise<{ error?: string; restarted?: boolean }> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data);
        const applicationId = access.install.applicationId;
        if (!applicationId)
            return { error: (await gameWords("games"))("errors.thisServerHasNotBeen") };
        const restart = await service.enableSounds(parsed.data, applicationId, access.ownerId);
        if (restart) await deployApplication(applicationId, access.ownerId, user.id);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.sounds.enable",
            targetType: "installedApp",
            targetId: parsed.data
        });
        return { restarted: restart };
    } catch (caught) {
        return { error: await failure(caught) };
    }
}

/** Offer the pack as the server's own resource pack (servers Polaris has no jar
 *  for), or take it back, and restart onto it. */
export async function serverPackAction(input: {
    installedAppId: string;
    on: boolean;
}): Promise<{ error?: string }> {
    const parsed = z.object({ installedAppId: serverId, on: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { user, access } = await requireGameServer(
            "games.manage",
            parsed.data.installedAppId
        );
        const applicationId = access.install.applicationId;
        if (!applicationId)
            return { error: (await gameWords("games"))("errors.thisServerHasNotBeen") };
        await service.setServerPack(
            parsed.data.installedAppId,
            applicationId,
            access.ownerId,
            parsed.data.on
        );
        await deployApplication(applicationId, access.ownerId, user.id);
        await recordAudit({
            actorId: user.id,
            action: parsed.data.on
                ? "minecraft.sounds.serverPack.on"
                : "minecraft.sounds.serverPack.off",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        return {};
    } catch (caught) {
        return { error: await failure(caught) };
    }
}
