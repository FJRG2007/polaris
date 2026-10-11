"use server";

/**
 * A server's seasonal decorations: whether they are on, and what is showing.
 * Reading is anybody who can see the server; the switch is the managers'.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { gameWords, messageText } from "../game-words";
import { seasonalView, setSeasonal, type SeasonalView } from "../../lib/minecraft/seasonal-service";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

const idSchema = z.string().uuid();

const saveSchema = z.object({ installedAppId: z.string().uuid(), on: z.boolean() }).strict();

export async function readSeasonalAction(
    installedAppId: string
): Promise<{ view?: SeasonalView; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.thatServerIsNotHere") };
    try {
        await requireGameServer("games.read", parsed.data);
        return { view: await seasonalView(parsed.data) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCouldNotBeRead")
        };
    }
}

export async function saveSeasonalAction(
    input: z.input<typeof saveSchema>
): Promise<{ view?: SeasonalView; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.thatCouldNotBeSaved") };
    const { installedAppId, on } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const view = await setSeasonal(access.ownerId, installedAppId, on);
        await recordAudit({
            actorId: user.id,
            action: "games.seasonal",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { on }
        });
        return { view };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCouldNotBeSaved")
        };
    }
}
