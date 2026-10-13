"use server";

/**
 * Where a game server keeps its world: on this server, on a NAS only while it is
 * stopped, or on a NAS all the time. Reading it is anybody's who may see the
 * server; choosing takes the manage grant, like every other setting of it.
 * The moves themselves are the dashboard's (`lib/storage-moves/app-storage`).
 */

import { z } from "zod";
import { gameWords } from "../game-words";
import { revalidatePath } from "next/cache";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";

type AppStorageView = AppHostTypes["AppStorageView"];

const { recordAudit } = host.auditService;
const { gamePermissionsFor, requireGameServer } = host.appsInstallAccess;
const { appStorageView, chooseAppStorage } = host.appStorage;

const chooseSchema = z.discriminatedUnion("mode", [
    z.object({
        installedAppId: z.string().trim().min(1),
        mode: z.literal("server"),
        connectionId: z.null().default(null)
    }),
    z.object({
        installedAppId: z.string().trim().min(1),
        mode: z.enum(["park", "nas"]),
        connectionId: z.string().uuid()
    })
]);

export async function readGameStorageAction(
    installedAppId: string
): Promise<AppStorageView | null> {
    try {
        const { user, access } = await requireGameServer("games.read", installedAppId);
        const applicationId = access.install.applicationId;
        if (!applicationId) return null;
        const [view, held] = await Promise.all([
            appStorageView(applicationId),
            gamePermissionsFor(user, installedAppId)
        ]);
        // The owner's NAS locations are theirs to pick from, not for everybody
        // who may only look at the server.
        return view && !held.includes("games.manage") ? { ...view, connections: [] } : view;
    } catch {
        return null;
    }
}

export async function chooseGameStorageAction(input: {
    installedAppId: string;
    mode: "server" | "park" | "nas";
    connectionId: string | null;
}): Promise<{ moving?: boolean; error?: string }> {
    const t = await gameWords("games");
    const parsed = chooseSchema.safeParse(input);
    if (!parsed.success) return { error: t("storage.refused.notOffered") };
    try {
        const { user, access } = await requireGameServer(
            "games.manage",
            parsed.data.installedAppId
        );
        const applicationId = access.install.applicationId;
        if (!applicationId) return { error: t("storage.refused.notDeployed") };
        const result = await chooseAppStorage({
            applicationId,
            choice: { mode: parsed.data.mode, connectionId: parsed.data.connectionId },
            actorId: user.id,
            serverLabel: ""
        });
        if ("refused" in result) return { error: t(`storage.refused.${result.refused}`) };
        await recordAudit({
            actorId: user.id,
            action: "games.storage.choose",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { mode: parsed.data.mode, connectionId: parsed.data.connectionId }
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return { moving: result.moving };
    } catch {
        return { error: t("storage.refused.unexpected") };
    }
}
