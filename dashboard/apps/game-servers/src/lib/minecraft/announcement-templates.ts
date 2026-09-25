/**
 * Announcements a server keeps, to send again: "restarting in five minutes",
 * "welcome to the event", the "done" after a reload.
 *
 * Kept on the install's own settings blob, beside the console's kept commands,
 * so they belong to the server - every operator of it sees the same ones - and
 * read back through the same schema that checks one before it is sent: a
 * template is an announcement with a name, and a stored one that no longer
 * passes is dropped rather than offered.
 */

import { z } from "zod";
import {
    CHAT_MAX,
    CHAT_MAX_LINES,
    DEFAULT_TIMING,
    LINE_MAX,
    SECONDS_MAX,
    isAnnouncementTarget,
    type Announcement
} from "./announcement";

/** Where the list lives on the install's settings. */
export const TEMPLATES_KEY = "announcementTemplates";
export const MAX_TEMPLATES = 30;
export const MAX_TEMPLATE_NAME = 40;

const line = z
    .string()
    .max(LINE_MAX * 4, "That line is too long")
    .refine((value) => !/[\0\r\n]/.test(value), "A title is one line");
const seconds = z.number().min(0).max(SECONDS_MAX);

/** One announcement, as the action and the template store both accept it. The
 *  length caps allow for codes: `&x&f&f&0&0&0&0` is fourteen characters of
 *  formatting in front of the words. */
export const announcementSchema = z.object({
    target: z.string().trim().refine(isAnnouncementTarget, "Choose everybody or one player"),
    title: line.default(""),
    subtitle: line.default(""),
    actionbar: line.default(""),
    chat: z
        .string()
        .max(CHAT_MAX * 4, "The chat message is too long")
        .refine((value) => !/[\0\r]/.test(value), "That message cannot be sent")
        .refine(
            (value) => value.split("\n").length <= CHAT_MAX_LINES,
            `A chat message is at most ${CHAT_MAX_LINES} lines`
        )
        .default(""),
    tagged: z.boolean().default(true),
    fadeIn: seconds.default(DEFAULT_TIMING.fadeIn),
    stay: seconds.default(DEFAULT_TIMING.stay),
    fadeOut: seconds.default(DEFAULT_TIMING.fadeOut),
    sound: z.string().max(80).default(""),
    // How long it stays. A kept template carries its "until" too, and it is the
    // send that refuses one whose moment has passed, not the store.
    hold: z.enum(["timed", "until", "manual"]).default("timed"),
    until: z.string().max(40).default("")
});

export interface AnnouncementTemplate {
    readonly id: string;
    readonly name: string;
    readonly announcement: Announcement;
}

/** One stored entry, or null when it is not usable. */
export function normalizeTemplate(input: {
    id: unknown;
    name: unknown;
    announcement: unknown;
}): AnnouncementTemplate | null {
    if (typeof input.id !== "string" || input.id.length === 0 || input.id.length > 64) return null;
    if (typeof input.name !== "string") return null;
    const name = input.name
        .replace(/[\0\r\n]/g, " ")
        .trim()
        .slice(0, MAX_TEMPLATE_NAME);
    if (name.length === 0) return null;
    const parsed = announcementSchema.safeParse(input.announcement);
    if (!parsed.success) return null;
    return { id: input.id, name, announcement: parsed.data };
}

/** The list one server carries, with anything unreadable left out. */
export function readTemplates(config: Record<string, unknown>): AnnouncementTemplate[] {
    const raw = config[TEMPLATES_KEY];
    if (!Array.isArray(raw)) return [];
    const list: AnnouncementTemplate[] = [];
    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        const template = normalizeTemplate({
            id: row.id,
            name: row.name,
            announcement: row.announcement
        });
        if (template && !list.some((kept) => kept.id === template.id)) list.push(template);
    }
    return list.slice(0, MAX_TEMPLATES);
}

/** The list with one added, or the one of that id rewritten in place. */
export function withTemplate(
    list: readonly AnnouncementTemplate[],
    entry: AnnouncementTemplate
): AnnouncementTemplate[] {
    if (list.some((kept) => kept.id === entry.id)) {
        return list.map((kept) => (kept.id === entry.id ? entry : kept));
    }
    if (list.length >= MAX_TEMPLATES) {
        throw new Error(`Only ${MAX_TEMPLATES} templates can be kept. Remove one first.`);
    }
    return [...list, entry];
}

export function withoutTemplate(
    list: readonly AnnouncementTemplate[],
    id: string
): AnnouncementTemplate[] {
    return list.filter((kept) => kept.id !== id);
}
