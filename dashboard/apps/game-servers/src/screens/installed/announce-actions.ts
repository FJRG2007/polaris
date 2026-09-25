"use server";

/**
 * Announcements: sending one to the players, and the templates a server keeps.
 *
 * The same grant as the console. An announcement is a narrower thing than a
 * console line - it can only put words on screens - but it is still the server
 * talking to everybody on it, which is what the console grant is for.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sendAnnouncement } from "../../lib/minecraft/service";
import { needsRepeating } from "../../lib/minecraft/announcement";
import { pinAnnouncement } from "../../lib/minecraft/live-display-service";
import {
    announcementSchema,
    MAX_TEMPLATE_NAME,
    type AnnouncementTemplate
} from "../../lib/minecraft/announcement-templates";
import {
    deleteTemplate,
    listTemplates,
    saveTemplate
} from "../../lib/minecraft/announcement-template-service";
import { host } from "@polaris/app-host";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

const sendSchema = z.object({
    installedAppId: z.string().uuid(),
    announcement: announcementSchema
});

/** Put an announcement on the players' screens. */
export async function sendAnnouncementAction(
    input: z.input<typeof sendSchema>
): Promise<{ sent?: number; kept?: boolean; error?: string }> {
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the announcement" };
    try {
        const { user, access } = await requireGameServer(
            "games.console",
            parsed.data.installedAppId
        );
        const sentAt = Date.now();
        const sent = await sendAnnouncement(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.announcement
        );
        // The game keeps an action bar up for about three seconds and has no
        // "until": anything meant to stay longer is sent again from here on.
        const kept = needsRepeating(parsed.data.announcement);
        if (kept) {
            await pinAnnouncement(
                access.ownerId,
                parsed.data.installedAppId,
                parsed.data.announcement,
                sentAt
            );
        }
        await recordAudit({
            actorId: user.id,
            action: "games.announce",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: {
                target: parsed.data.announcement.target,
                title: parsed.data.announcement.title,
                chat: parsed.data.announcement.chat,
                hold: parsed.data.announcement.hold
            }
        });
        return { sent, kept };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not take that" };
    }
}

/** The templates this server keeps. Empty rather than an error for somebody who
 *  may not see them. */
export async function listAnnouncementTemplatesAction(
    installedAppId: string
): Promise<{ templates: AnnouncementTemplate[] }> {
    const parsed = z.string().uuid().safeParse(installedAppId);
    if (!parsed.success) return { templates: [] };
    try {
        await requireGameServer("games.console", parsed.data);
        return { templates: await listTemplates(parsed.data) };
    } catch {
        return { templates: [] };
    }
}

const saveSchema = z.object({
    installedAppId: z.string().uuid(),
    /** Absent for a new one; present when one is being rewritten. */
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, "Give it a name").max(MAX_TEMPLATE_NAME),
    announcement: announcementSchema
});

export async function saveAnnouncementTemplateAction(
    input: z.input<typeof saveSchema>
): Promise<{ templates?: AnnouncementTemplate[]; id?: string; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the template" };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        const id = parsed.data.id ?? randomUUID();
        const templates = await saveTemplate(parsed.data.installedAppId, {
            id,
            name: parsed.data.name,
            announcement: parsed.data.announcement
        });
        await recordAudit({
            actorId: user.id,
            action: "games.announce.template-save",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { id, name: parsed.data.name }
        });
        revalidatePath(`/apps/installed/${parsed.data.installedAppId}`);
        return { templates, id };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "That template could not be kept"
        };
    }
}

export async function deleteAnnouncementTemplateAction(
    installedAppId: string,
    id: string
): Promise<{ templates?: AnnouncementTemplate[]; error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), id: z.string().min(1).max(64) })
        .safeParse({ installedAppId, id });
    if (!parsed.success) return { error: "That template could not be removed" };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        const templates = await deleteTemplate(parsed.data.installedAppId, parsed.data.id);
        await recordAudit({
            actorId: user.id,
            action: "games.announce.template-delete",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { id: parsed.data.id }
        });
        return { templates };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "That template could not be removed"
        };
    }
}
