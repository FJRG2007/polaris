/**
 * The half of search that costs a query.
 *
 * Tasks, pages, notes and people are too many to hand to the browser the way the
 * resource index is, and they change while somebody is looking at them - so they
 * are searched where they live, one scope at a time, and only once a command has
 * said which scope was meant. That is the whole point of the commands: without
 * one, typing a name runs nothing here.
 *
 * The search itself is `searchMentions`, which already answers "what can this
 * person see" for exactly these four kinds. Reusing it means a space somebody
 * loses access to disappears from both the mention picker and the search on the
 * same day, rather than on whichever day the second copy is remembered.
 */

import * as core from "@polaris/core";
import * as mentions from "@/lib/rich-text/mention-service";
import { userHasManage, type SessionUser } from "@/lib/session";
import { referenceHref, type ReferenceKind } from "@/components/rich-text/references";

/** One match, ready to draw. */
export interface SearchHit {
    readonly id: string;
    readonly scope: core.RemoteSearchScope;
    readonly label: string;
    /** Where it lives: the space a task is in, the person's address. */
    readonly detail: string;
    readonly href: string;
    /** A task's handle, "PLR-42", shown as a badge beside the name. */
    readonly reference?: string;
    readonly status?: { readonly name: string; readonly color: string } | null;
    /** An avatar, for the scopes that have one. */
    readonly image?: string | null;
}

/** Rows one scope returns. A panel can show more than a popup, and the arrow
 *  keys make a longer list cheap to walk. */
const PER_SCOPE = 12;

const SCOPE_KINDS: Record<core.RemoteSearchScope, ReferenceKind> = {
    tasks: "task",
    docs: "doc",
    notes: "note",
    users: "user"
};

/**
 * Whether this account may search a scope at all.
 *
 * Notes are the account's own and people are already visible wherever they share
 * work, so neither needs a permission of its own. Tasks and pages are behind the
 * same permission their screens are: search must not become the way to read the
 * name of something the app itself would refuse to open.
 */
export async function canSearchScope(user: SessionUser, scope: core.RemoteSearchScope): Promise<boolean> {
    if (scope === "tasks" || scope === "docs") return userHasManage(user, "tasks.read");
    return true;
}

/**
 * Search one scope.
 *
 * @param user - Who is asking. Everything is scoped to what they already reach.
 * @param input - The scope and what was typed after the command; an empty query
 *                answers with what was touched most recently.
 */
export async function lookup(user: SessionUser, input: core.SearchLookupInput): Promise<SearchHit[]> {
    if (!(await canSearchScope(user, input.scope))) return [];
    const candidates = await mentions.searchMentions(
        { id: user.id, isAdmin: user.isAdmin },
        [SCOPE_KINDS[input.scope]],
        input.query,
        PER_SCOPE
    );
    return candidates.map((candidate) => toHit(input.scope, candidate));
}

function toHit(scope: core.RemoteSearchScope, candidate: mentions.MentionCandidate): SearchHit {
    return {
        id: candidate.id,
        scope,
        label: candidate.label,
        // The reference is drawn as a badge here, so the line underneath is
        // where the thing lives rather than the handle a second time.
        detail: candidate.place ?? candidate.detail,
        href: hitHref(candidate),
        reference: candidate.reference,
        status: candidate.status ?? null,
        image: candidate.image
    };
}

/**
 * Where a match opens.
 *
 * A person has no page of their own in Polaris, so the useful destination is the
 * work: their tasks, across every space the reader can see. Everything else has
 * the address its chips already link to.
 */
function hitHref(candidate: mentions.MentionCandidate): string {
    if (candidate.kind === "user") return `/tasks/everything?assignee=${encodeURIComponent(candidate.id)}`;
    return referenceHref(candidate.kind, candidate.id) ?? "/";
}
