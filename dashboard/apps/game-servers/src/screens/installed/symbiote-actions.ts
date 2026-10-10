"use server";

/**
 * Symbiote on one server: whether it is on the list, and the one-click install
 * and removal.
 *
 * Reading is the moderators'; changing the list is the managers'. Nothing
 * restarts: the server picks the change up on its next start.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { revalidatePath } from "next/cache";
import { gameWords, messageText } from "../game-words";
import * as service from "../../lib/minecraft/symbiote-service";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

const serverId = z.string().uuid();

const failure = async (caught: unknown, fallback: string): Promise<string> =>
    caught instanceof Error ? await messageText(caught.message) : fallback;

export async function symbioteStateAction(
    installedAppId: string
): Promise<{ state?: service.SymbioteState; error?: string }> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.read", parsed.data);
        const applicationId = access.install.applicationId;
        if (!applicationId)
            return { error: (await gameWords("games"))("errors.thisServerHasNotBeen") };
        return { state: await service.symbioteState(applicationId, access.ownerId) };
    } catch (caught) {
        return {
            error: await failure(caught, (await gameWords("games"))("errors.couldNotReadSymbiote"))
        };
    }
}

const switchSchema = z.object({ installedAppId: serverId, on: z.boolean() });

/** Put Symbiote on the server's mod list, or take it off. */
export async function setSymbioteAction(input: {
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
        await service.setSymbiote(applicationId, access.ownerId, parsed.data.on);
        await recordAudit({
            actorId: user.id,
            action: parsed.data.on ? "minecraft.symbiote.install" : "minecraft.symbiote.remove",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return {};
    } catch (caught) {
        return {
            error: await failure(
                caught,
                (await gameWords("games"))("errors.couldNotChangeSymbiote")
            )
        };
    }
}
