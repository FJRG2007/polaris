"use server";

/**
 * What the join-password card does with Polaris's own login mod: read how it is
 * doing, switch it, and forget a player's password.
 *
 * Kept apart from `minecraft-actions` because none of it goes through the
 * settings form: the mod's variables are not manifest settings, and turning it on
 * writes a secret the form must never see.
 *
 * enigma:allow-unlimited-auth - nothing here checks a password. These are an
 * operator's actions behind their own session and the games permissions; the
 * guessing surface is the mod's route, which is limited per player and per server
 * (`polaris-login-service`).
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { PLAYER_NAME } from "../../lib/minecraft/polaris-login";
import * as service from "../../lib/minecraft/polaris-login-service";
import { host } from "@polaris/app-host";

const { recordAudit } = host.auditService;
const { deployApplication } = host.deployService;
const { requireGameServer } = host.appsInstallAccess;

const serverId = z.string().uuid();

const failure = (caught: unknown, fallback: string) =>
    caught instanceof Error ? caught.message : fallback;

export async function loginStateAction(
    installedAppId: string
): Promise<{ state?: service.LoginState; error?: string }> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: "Server not found" };
    try {
        const { access } = await requireGameServer("games.read", parsed.data);
        const applicationId = access.install.applicationId;
        if (!applicationId) return { error: "This server has not been deployed yet" };
        return { state: await service.loginState(parsed.data, applicationId, access.ownerId) };
    } catch (caught) {
        return { error: failure(caught, "Could not read the login state") };
    }
}

const switchSchema = z.object({ installedAppId: serverId, on: z.boolean() });

/** Switch the mod and restart the server onto it. */
export async function setLoginAction(input: {
    installedAppId: string;
    on: boolean;
}): Promise<{ error?: string }> {
    const parsed = switchSchema.safeParse(input);
    if (!parsed.success) return { error: "Server not found" };
    try {
        const { user, access } = await requireGameServer(
            "games.manage",
            parsed.data.installedAppId
        );
        const applicationId = access.install.applicationId;
        if (!applicationId) throw new Error("This server has not been deployed yet");
        await service.setLogin(
            parsed.data.installedAppId,
            applicationId,
            access.ownerId,
            parsed.data.on
        );
        await deployApplication(applicationId, access.ownerId, user.id);
        await recordAudit({
            actorId: user.id,
            action: parsed.data.on ? "minecraft.login.enable" : "minecraft.login.disable",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return { error: failure(caught, "Could not change the login") };
    }
}

const forgetSchema = z.object({
    installedAppId: serverId,
    player: z.string().trim().regex(PLAYER_NAME, "That is not a player name")
});

/** Forget one player's password. Nothing restarts: the mod asks on every join. */
export async function forgetLoginAction(input: {
    installedAppId: string;
    player: string;
}): Promise<{ error?: string }> {
    const parsed = forgetSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the name" };
    try {
        const { user } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const removed = await service.forgetPlayer(parsed.data.installedAppId, parsed.data.player);
        if (!removed) return { error: `${parsed.data.player} has no password on this server` };
        await recordAudit({
            actorId: user.id,
            action: "minecraft.login.forget",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { player: parsed.data.player }
        });
        return {};
    } catch (caught) {
        return { error: failure(caught, "Could not reset the password") };
    }
}
