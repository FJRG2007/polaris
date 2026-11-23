import type { KnownPerson } from "@/components/rich-text/suggestion";

/**
 * The people a conversation screen already holds, for the @ picker to draw the
 * moment "@" is typed: the conversation's own members first, then whoever has
 * spoken on screen, most recent first - the order Discord's list starts in.
 *
 * Nobody twice, never the reader, never an author with no account (a webhook,
 * somebody who has left). The search that follows only adds to this.
 */
export function knownPeopleOf(input: {
    readonly viewerId: string | null;
    readonly members?: readonly { readonly id: string; readonly name: string | null }[];
    readonly authors?: readonly { readonly authorId?: string | null; readonly authorName?: string | null }[];
}): KnownPerson[] {
    const seen = new Set<string>(input.viewerId ? [input.viewerId] : []);
    const people: KnownPerson[] = [];
    const add = (id: string | null | undefined, name: string | null | undefined) => {
        const label = name?.trim();
        if (!id || !label || seen.has(id)) return;
        seen.add(id);
        people.push({ id, label });
    };
    for (const member of input.members ?? []) add(member.id, member.name);
    const authors = input.authors ?? [];
    for (let at = authors.length - 1; at >= 0; at--) add(authors[at]!.authorId, authors[at]!.authorName);
    return people;
}
