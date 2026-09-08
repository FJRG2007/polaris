"use server";

/**
 * Sharing one thing with somebody, from whichever screen it is being shared on.
 *
 * One set of actions rather than a set per app, because the four steps are the
 * same everywhere - who may share this, who is on offer, write it, take it back -
 * and the only part that differs is the first, which is dispatched in
 * `sharing-service.ts` to the app that owns the thing.
 *
 * Every one of these resolves the caller against the subject **before** touching
 * a grant, and the subject is named by the screen rather than by the row: a
 * request cannot hand over a grant id and have it looked up, because that would
 * be a way of editing a grant on something else.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { findPeople } from "@/lib/people-search";
import { recordAudit } from "@/lib/audit-service";
import {
    owningOrgIds,
    requireMayShare,
    shareCandidates,
    type GrantCandidate
} from "@/lib/access/sharing-service";
import {
    GrantError,
    listSubjectGrants,
    removeGrant,
    writeGrant,
    type GrantView
} from "@/lib/access/grants";

/** What a refusal reads as. Anything else is logged and replaced, the same rule
 *  the rest of the app follows: an internal message names paths nobody asked to
 *  publish. */
function refusal(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof GrantError) return { error: caught.message };
    if (caught instanceof Error && caught.name.endsWith("AccessError")) {
        return { error: caught.message };
    }
    console.error("[access] share failed", caught);
    return { error: fallback };
}

/** Read the subject off the wire. An unknown one is refused rather than guessed
 *  at: it decides which app is asked whether the caller may share. */
function subjectOf(value: unknown): core.GrantSubject {
    if (!core.isGrantSubject(value)) throw new GrantError("That cannot be shared");
    return value;
}

/**
 * Redraw the screens a share changes, where the server draws them.
 *
 * Only Places: its lists are rendered per request and a lent door has to appear
 * for the person it was lent to. Chat and Tasks resolve access on the way into
 * every screen and already redraw themselves on the caller's own next move.
 */
function settled(subject: core.GrantSubject): void {
    if (subject === "place.device" || subject === "place.camera") revalidatePath("/places");
}

export async function listGrantsAction(
    subject: string,
    subjectId: string
): Promise<{ grants?: GrantView[]; candidates?: GrantCandidate[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const [grants, candidates] = await Promise.all([
            listSubjectGrants(kind, String(subjectId)),
            shareCandidates(user, kind, String(subjectId))
        ]);
        return { grants, candidates };
    } catch (caught) {
        return refusal(caught, "That could not be read");
    }
}

export async function shareAction(
    subject: string,
    subjectId: string,
    input: unknown
): Promise<{ grants?: GrantView[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const parsed = core.accessGrantSchema.safeParse(input);
        if (!parsed.success) {
            return { error: parsed.error.issues[0]?.message ?? "That share could not be written" };
        }
        // The same scoping the picker was filled from, asked again here: what a
        // form offered is not what a call has to carry.
        await writeGrant(
            kind,
            String(subjectId),
            parsed.data,
            user.id,
            await owningOrgIds(user, kind, String(subjectId))
        );
        await recordAudit({
            actorId: user.id,
            action: "access.shared",
            targetType: kind,
            targetId: String(subjectId),
            metadata: {
                principalType: parsed.data.principalType,
                capability: parsed.data.capability,
                // Never the note: it is free text somebody wrote about a person.
                bounded: Boolean(parsed.data.endsAt || parsed.data.startMinute || parsed.data.maxUses)
            }
        });
        settled(kind);
        return { grants: await listSubjectGrants(kind, String(subjectId)) };
    } catch (caught) {
        return refusal(caught, "That share could not be written");
    }
}

/**
 * People this thing can be handed to, by name.
 *
 * Searched rather than listed, and through the same rules every other people
 * search here obeys: nothing at all under two characters, and anybody who has
 * hidden themselves is not found. Sharing a door does not entitle the sharer to
 * a directory of the instance.
 */
export async function findSharePeopleAction(
    subject: string,
    subjectId: string,
    query: string
): Promise<{ people?: { id: string; name: string }[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        // `reachableOnly` is false: the question is who exists, not who holds the
        // app - somebody lent a door reaches Places because of the grant itself.
        const found = await findPeople({ id: user.id }, String(query), { reachableOnly: false });
        return { people: found.people };
    } catch (caught) {
        return refusal(caught, "Nobody could be looked up");
    }
}

export async function revokeShareAction(
    subject: string,
    subjectId: string,
    grantId: string
): Promise<{ grants?: GrantView[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        await removeGrant(kind, String(subjectId), String(grantId));
        await recordAudit({
            actorId: user.id,
            action: "access.revoked",
            targetType: kind,
            targetId: String(subjectId)
        });
        settled(kind);
        return { grants: await listSubjectGrants(kind, String(subjectId)) };
    } catch (caught) {
        return refusal(caught, "That share could not be taken back");
    }
}
