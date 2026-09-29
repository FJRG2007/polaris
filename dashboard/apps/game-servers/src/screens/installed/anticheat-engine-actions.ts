"use server";

/**
 * Polaris's anti-cheat engine on one server: whether it is on, and the switch.
 *
 * Reading is the moderators'; switching is the managers', and restarts the server
 * onto the change, since a plugin is only loaded when the server starts.
 */

import { z } from "zod";
import { gameWords } from "../game-words";
import { host } from "@polaris/app-host";
import { revalidatePath } from "next/cache";
import * as service from "../../lib/minecraft/polaris-anticheat-service";

const { recordAudit } = host.auditService;
const { deployApplication } = host.deployService;
const { requireGameServer } = host.appsInstallAccess;

const serverId = z.string().uuid();

const failure = (caught: unknown, fallback: string) =>
    caught instanceof Error ? caught.message : fallback;

export async function anticheatStateAction(
    installedAppId: string
): Promise<{ state?: service.AnticheatState; error?: string }> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.read", parsed.data);
        const applicationId = access.install.applicationId;
        if (!applicationId)
            return { error: (await gameWords("games"))("errors.thisServerHasNotBeen") };
        return { state: await service.anticheatState(applicationId, access.ownerId) };
    } catch (caught) {
        return { error: failure(caught, (await gameWords("games"))("errors.couldNotReadTheAnti")) };
    }
}

const switchSchema = z.object({ installedAppId: serverId, on: z.boolean() });

/** Switch the engine and restart the server onto it. */
export async function setAnticheatAction(input: {
    installedAppId: string;
    on: boolean;
}): Promise<{ error?: string }> {
    const parsed = switchSchema.safeParse(input);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { user, access } = await requireGameServer(
            "games.manage",
            parsed.data.installedAppId
        );
        const applicationId = access.install.applicationId;
        if (!applicationId)
            throw new Error((await gameWords("games"))("errors.thisServerHasNotBeen"));
        await service.setAnticheat(
            parsed.data.installedAppId,
            applicationId,
            access.ownerId,
            parsed.data.on
        );
        await deployApplication(applicationId, access.ownerId, user.id);
        await recordAudit({
            actorId: user.id,
            action: parsed.data.on ? "minecraft.anticheat.enable" : "minecraft.anticheat.disable",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return {
            error: failure(caught, (await gameWords("games"))("errors.couldNotChangeTheAnti"))
        };
    }
}
