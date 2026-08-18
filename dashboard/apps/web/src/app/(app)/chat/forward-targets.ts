/**
 * Where a forwarded message can go, and which of those a person is shown.
 *
 * Its own module rather than part of the dialog, because it is the rule the
 * dialog exists to get right and a rule with a test on it outlives the markup
 * around it. The dialog imports it; nothing here imports the dialog, so it can
 * be asserted without dragging a server action into a test run.
 */

/** One thing a message can be sent to, as the list draws it. */
export interface Target {
    readonly id: string;
    readonly name: string;
    readonly kind: "text" | "voice" | "dm" | "group";
    /** The server it is in, or null for the conversations that are people. What
     *  the browse is carved up by. */
    readonly spaceId: string | null;
    /** Whose faces to draw, for the conversations that are people rather than
     *  rooms. Empty for a channel, where the name is the whole label. */
    readonly people: readonly { id: string; name: string }[];
    /** The server it belongs to, for the line under a search hit: "general" on
     *  its own is three different channels in three different servers. */
    readonly place: string | null;
}

/**
 * Where a message is going, when that was decided before the dialog opened.
 *
 * Answering somebody privately is the same movement as forwarding - their words
 * arrive quoted in a conversation they are not currently in - and the only
 * difference is that there is nothing to choose. So it is this dialog with the
 * list taken away and the note turned into what is being said.
 */
export interface PrivateReply {
    readonly channelId: string;
    readonly name: string;
}

/**
 * What the list shows, given what has been typed and where somebody has browsed.
 *
 * Pulled out of the render because it is the whole of the complaint that led to
 * this arrangement, and it is exactly the kind of rule that gets quietly undone
 * by a later edit: somebody in four servers of thirty channels was shown a
 * hundred and twenty rows at the top level, and the four people they talk to
 * were underneath all of it.
 *
 * Three states, in order of precedence. Typing beats everything and reaches into
 * every server at once, because nobody browses to something they can name. Then
 * whichever server was opened. Then the top level, which is people and groups
 * and nothing else.
 */
export function listedTargets(
    all: readonly Target[],
    where: { found: readonly Target[] | null; inside: string | null }
): readonly Target[] {
    if (where.found) return where.found;
    if (where.inside) return all.filter((target) => target.spaceId === where.inside);
    return all.filter((target) => target.spaceId === null);
}
