"use server";

/**
 * Who can reach one server, from the server's own screen.
 *
 * Thin: every rule about what may be handed out lives in install-sharing, so the
 * dialog cannot be the thing that decides it. These only validate the shape and
 * hand it over.
 */

import { z } from "zod";
import { PERMISSIONS } from "@polaris/core";
import { listInstallAccess, revokeInstallAccess, shareInstall, type InstallAccessView } from "@/lib/apps/install-sharing";

const shareSchema = z.object({
    installedAppId: z.string().uuid(),
    /** An email address or a username; which one it is decides whether this ends
     *  in a grant or an invite. */
    identifier: z.string().trim().min(1).max(254),
    actions: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
    canShare: z.boolean(),
    /** Null for no end date. */
    expiresInDays: z.number().int().min(1).max(365).nullable()
});

export type ShareInstallFormInput = z.infer<typeof shareSchema>;

export async function installAccessAction(
    installedAppId: string
): Promise<{ view?: InstallAccessView; error?: string }> {
    try {
        return { view: await listInstallAccess(installedAppId) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not read who can reach this server" };
    }
}

export async function shareInstallAction(
    input: ShareInstallFormInput
): Promise<{ granted?: true; invite?: { url?: string; sendError?: string }; error?: string }> {
    const parsed = shareSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        return await shareInstall(parsed.data);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not give access" };
    }
}

export async function revokeInstallAccessAction(
    installedAppId: string,
    grantId: string
): Promise<{ error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), grantId: z.string().uuid() })
        .safeParse({ installedAppId, grantId });
    if (!parsed.success) return { error: "That is not access on this server" };
    try {
        return await revokeInstallAccess(parsed.data.installedAppId, parsed.data.grantId);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove that access" };
    }
}
