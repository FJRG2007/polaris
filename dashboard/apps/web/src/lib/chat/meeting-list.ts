/**
 * What the meetings list can ask for, and what each row is right now.
 *
 * Pure, so the server that filters and the screen that draws read the same
 * rules: a meeting nobody has walked into yet is cancelled or deleted, never
 * "ended", and only the host is offered any of the three - the same check
 * `requireHost` makes before it closes anything.
 */

import { z } from "zod";
import type { Prisma } from "@polaris/db";

export const MEETING_WHEN = ["upcoming", "past", "all"] as const;
export const MEETING_SCOPE = ["all", "mine"] as const;
export const MEETING_SORT = ["when", "title"] as const;

export type MeetingWhen = (typeof MEETING_WHEN)[number];
export type MeetingScope = (typeof MEETING_SCOPE)[number];
export type MeetingSort = (typeof MEETING_SORT)[number];

/** The longest search the list takes. A meeting's name is shorter than this. */
export const MAX_MEETING_SEARCH = 120;

/**
 * The list's query as it arrives on the poll route: every field optional, so
 * the bare request the meeting room makes still reads the whole list.
 */
export const meetingListQuerySchema = z.object({
    q: z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().max(MAX_MEETING_SEARCH))
        .optional(),
    when: z.enum(MEETING_WHEN).optional(),
    scope: z.enum(MEETING_SCOPE).optional(),
    sort: z.enum(MEETING_SORT).optional(),
    dir: z.enum(["asc", "desc"]).optional()
});

export type MeetingListQuery = z.infer<typeof meetingListQuerySchema>;

/** What a row is, by what is true of it now. */
export type MeetingState = "live" | "upcoming" | "open" | "past";

export function meetingState(
    meeting: { readonly present: number; readonly scheduledAt: string | null },
    now: number = Date.now()
): MeetingState {
    if (meeting.present > 0) return "live";
    if (!meeting.scheduledAt) return "open";
    return new Date(meeting.scheduledAt).getTime() < now ? "past" : "upcoming";
}

/** Whether `actorId` may change or close a meeting: its host, and nobody else. */
export function mayManageMeeting(hostId: string, actorId: string): boolean {
    return hostId === actorId;
}

/**
 * How closing a meeting is named. A running one is ended for the people in it;
 * one in the diary is cancelled; a room with no time, or one whose time has
 * passed with nobody in it, is deleted.
 */
export type MeetingRemoval = "end" | "cancel" | "delete";

export function removalFor(state: MeetingState): MeetingRemoval {
    if (state === "live") return "end";
    if (state === "upcoming") return "cancel";
    return "delete";
}

/**
 * The rows `query` asks for, in the database's terms. `live` is what counts as
 * somebody being in the room - the same filter the presence count reads - so a
 * meeting whose hour has passed with people still in it stays upcoming.
 */
export function meetingListWhere(
    actorId: string,
    query: MeetingListQuery,
    now: Date,
    live: Prisma.MeetingParticipantWhereInput
): Prisma.MeetingWhereInput {
    const and: Prisma.MeetingWhereInput[] = [
        { channelId: null, endedAt: null },
        query.scope === "mine"
            ? { hostId: actorId }
            : { OR: [{ hostId: actorId }, { invites: { some: { userId: actorId } } }] }
    ];
    if (query.q) and.push({ title: { contains: query.q, mode: "insensitive" } });
    if (query.when === "upcoming") {
        and.push({
            OR: [
                { scheduledAt: null },
                { scheduledAt: { gte: now } },
                { participants: { some: live } }
            ]
        });
    } else if (query.when === "past") {
        and.push({ scheduledAt: { lt: now } }, { participants: { none: live } });
    }
    return { AND: and };
}

/** The order `query` asks for. A room with no time sorts after the diary either way. */
export function meetingListOrder(query: MeetingListQuery): Prisma.MeetingOrderByWithRelationInput[] {
    const dir = query.dir ?? "asc";
    if (query.sort === "title") return [{ title: dir }, { createdAt: "desc" }];
    return [{ scheduledAt: { sort: dir, nulls: "last" } }, { createdAt: "desc" }];
}

/** The list with one row taken out, and where it stood, so a refusal can put it back. */
export function withoutRow<T extends { readonly id: string }>(
    rows: readonly T[],
    id: string
): { rows: T[]; index: number } {
    const index = rows.findIndex((row) => row.id === id);
    return { rows: rows.filter((row) => row.id !== id), index };
}

/** Put a row back where it stood, unless a reload already brought it back. */
export function restoreRow<T extends { readonly id: string }>(
    rows: readonly T[],
    row: T,
    index: number
): T[] {
    if (rows.some((other) => other.id === row.id)) return [...rows];
    const at = index < 0 ? rows.length : Math.min(index, rows.length);
    return [...rows.slice(0, at), row, ...rows.slice(at)];
}
