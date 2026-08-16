/**
 * Who owns a group.
 *
 * The column, and failing that whoever started it. The fallback is not
 * decoration: a group made before the column was being filled in has none, and an
 * ownerless group is one nobody can rename, hand over or moderate - including the
 * person who made it, who was told they were not the owner of their own group.
 * Whoever created it is the same answer the column is set to now, so reading it
 * this way repairs those without waiting for anything to be written.
 *
 * Its own module rather than a line in `access`, because both that and the
 * service ask it, and it is a fact about a row rather than a decision about an
 * actor.
 */

export function groupOwnerId(channel: {
    readonly ownerId: string | null;
    readonly createdById?: string | null;
}): string | null {
    return channel.ownerId ?? channel.createdById ?? null;
}
