/**
 * Telling the people who were named.
 *
 * A mention that does not reach anybody is decoration, so every surface that
 * stores rich text calls this after the write. It is deliberately the only place
 * that does: the rule for who hears about being named - and who must not - is
 * one rule, not one per screen.
 *
 * Two things it refuses to do. It never notifies somebody who cannot open what
 * they were named in, because a notification linking to a refusal is worse than
 * silence. And it never notifies the person who wrote the text, who already
 * knows.
 */

import { prisma } from "@polaris/db";
import * as access from "@/lib/tasks/access";
import { notify } from "@/lib/notifications/dispatch";
import { extractReferences } from "@/components/rich-text/markdown";

export interface MentionNotice {
    /** The Markdown that was just stored. */
    readonly body: string;
    /** What it said before, when this is an edit. Whoever was already named in
     *  it is not told again: editing a sentence is not a second mention. */
    readonly previousBody?: string;
    /** Null when a rule wrote the text rather than a person, in which case
     *  everybody named hears about it - there is nobody to leave out. */
    readonly actorId: string | null;
    /** What the notification is called: the task, the page, the note. */
    readonly title: string;
    readonly href: string;
    /** The space whatever this was written on belongs to, so the people named
     *  can be checked against it. Null for text that sits outside a space, which
     *  only its own author can read anyway. */
    readonly spaceId: string | null;
    /** People the caller has already told for another reason. */
    readonly except?: readonly string[];
}

/** How many people one mention can reach, so naming a large team cannot become
 *  a broadcast nobody meant to send. */
const MAX_RECIPIENTS = 50;

export async function notifyMentions(input: MentionNotice): Promise<void> {
    try {
        const already = new Set(
            extractReferences(input.previousBody ?? "").map((reference) => `${reference.kind}/${reference.id}`)
        );
        const named = extractReferences(input.body).filter(
            (reference) =>
                (reference.kind === "user" || reference.kind === "team") &&
                !already.has(`${reference.kind}/${reference.id}`)
        );
        if (named.length === 0) return;

        const teamIds = named.filter((reference) => reference.kind === "team").map((reference) => reference.id);
        const teamMembers = teamIds.length
            ? await prisma.teamMember.findMany({ where: { teamId: { in: teamIds } }, select: { userId: true } })
            : [];

        const recipients = new Set([
            ...named.filter((reference) => reference.kind === "user").map((reference) => reference.id),
            ...teamMembers.map((member) => member.userId)
        ]);
        if (input.actorId) recipients.delete(input.actorId);
        for (const userId of input.except ?? []) recipients.delete(userId);
        if (recipients.size === 0) return;

        const allowed = await reachable([...recipients].slice(0, MAX_RECIPIENTS), input.spaceId);
        for (const userId of allowed) {
            await notify({
                userId,
                event: "tasks.mentioned",
                title: input.title,
                body: "You were mentioned.",
                href: input.href
            });
        }
    } catch (caught) {
        // A write must not fail because somebody could not be told about it.
        console.error("polaris: could not deliver mention notifications:", caught);
    }
}

/** Of the people named, the ones who can open what they were named in. */
async function reachable(userIds: readonly string[], spaceId: string | null): Promise<string[]> {
    if (!spaceId) return [];
    const users = await prisma.user.findMany({
        where: { id: { in: [...userIds] }, bannedAt: null },
        select: { id: true, isAdmin: true }
    });
    const checked = await Promise.all(
        users.map(async (user) => {
            const role = await access.resolveSpaceRole({ id: user.id, isAdmin: user.isAdmin }, spaceId);
            return role ? user.id : null;
        })
    );
    return checked.filter((id): id is string => id !== null);
}
