"use server";

/** Sharing a calendar with people and teams, and publishing it by link. */

import { z } from "zod";
import * as sharing from "../lib/sharing";
import * as schemas from "../lib/schemas";
import type { ShareView } from "../lib/wire";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";

export async function listSharesAction(calendarId: unknown): Promise<Outcome<{ shares: ShareView[] }>> {
    const parsed = schemas.uuidSchema.safeParse(calendarId);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({ shares: await sharing.listShares(await requireCalendarUser(), parsed.data) }));
}

export async function shareCalendarAction(input: unknown): Promise<Outcome<{ shares: ShareView[] }>> {
    const parsed = schemas.shareInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        await sharing.share(user, parsed.data);
        return { shares: await sharing.listShares(user, parsed.data.calendarId) };
    });
}

export async function unshareCalendarAction(shareId: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(shareId);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await sharing.unshare(await requireCalendarUser(), parsed.data);
        return {};
    });
}

export async function shareTargetsAction(
    query: unknown
): Promise<
    Outcome<{
        people: { id: string; name: string; username: string | null }[];
        teams: { id: string; name: string; orgName: string }[];
    }>
> {
    const parsed = z.string().trim().max(100).safeParse(query);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => sharing.shareTargets(await requireCalendarUser(), parsed.data));
}

export async function publishCalendarAction(input: unknown): Promise<Outcome<{ token: string | null }>> {
    const parsed = schemas.publishInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        token: await sharing.publish(await requireCalendarUser(), parsed.data.calendarId, parsed.data.mode)
    }));
}

export async function rotatePublicLinkAction(calendarId: unknown): Promise<Outcome<{ token: string }>> {
    const parsed = schemas.uuidSchema.safeParse(calendarId);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({ token: await sharing.rotatePublicLink(await requireCalendarUser(), parsed.data) }));
}

const mailInput = z.object({
    calendarId: schemas.uuidSchema,
    email: z.string().trim().toLowerCase().pipe(z.string().email().max(320))
});

export async function mailPublicLinkAction(input: unknown): Promise<Outcome<object>> {
    const parsed = mailInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await sharing.mailPublicLink(await requireCalendarUser(), parsed.data.calendarId, parsed.data.email);
        return {};
    });
}
