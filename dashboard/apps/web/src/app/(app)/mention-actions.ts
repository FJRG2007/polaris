"use server";

/**
 * What the @ and # pickers ask for.
 *
 * One action, called from every editor in Polaris - a task description, a
 * comment, a page, a note - because the answer does not depend on where the
 * caret is: it depends on who is typing and what they already reach. Keeping it
 * here rather than in one app's actions file is what stops the next surface that
 * wants mentions from writing a second, subtly different one.
 *
 * The search itself is scoped in the service. This layer only establishes who is
 * asking and refuses a query it cannot make sense of.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import * as mentions from "@/lib/rich-text/mention-service";
import { REFERENCE_KINDS } from "@/components/rich-text/references";

const searchInput = z.object({
    kinds: z.array(z.enum(REFERENCE_KINDS)).min(1).max(REFERENCE_KINDS.length),
    // Long enough for a task title somebody pasted in, short enough that it is
    // still a search and not a document.
    query: z.string().max(120)
});

export async function searchMentionsAction(
    input: unknown
): Promise<{ results?: mentions.MentionCandidate[]; error?: string }> {
    const parsed = searchInput.safeParse(input);
    if (!parsed.success) return { error: "That search could not be read" };

    const user = await requireUser();
    try {
        const results = await mentions.searchMentions(
            { id: user.id, isAdmin: user.isAdmin },
            parsed.data.kinds,
            parsed.data.query
        );
        return { results };
    } catch (caught) {
        console.error(caught);
        return { error: "Those could not be looked up" };
    }
}

const resolveInput = z
    .array(z.object({ kind: z.enum(REFERENCE_KINDS), id: z.string().uuid() }))
    // A paste is one document, not a crawl of the instance.
    .max(50);

/** The names behind pasted addresses, keyed "kind/id". */
export async function resolveReferencesAction(input: unknown): Promise<{ labels: Record<string, string> }> {
    const parsed = resolveInput.safeParse(input);
    if (!parsed.success) return { labels: {} };

    const user = await requireUser();
    try {
        return { labels: await mentions.resolveReferences({ id: user.id, isAdmin: user.isAdmin }, parsed.data) };
    } catch (caught) {
        console.error(caught);
        return { labels: {} };
    }
}
