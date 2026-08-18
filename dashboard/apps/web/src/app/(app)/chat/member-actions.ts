/**
 * What the roster offers about one person, and why.
 *
 * Its own module rather than a pile of conditions inside the menu, because these
 * are rules rather than markup: which of them apply is decided by what kind of
 * room this is and what the reader may do in it, and getting one wrong shows up
 * as a menu item that either does nothing or does something nobody may undo.
 *
 * Two of them are worth stating out loud, because they are decisions rather than
 * consequences.
 *
 * **A group cannot ban.** A group is people who got there by invitation from
 * somebody already in it. There is no door to stand at, so removing somebody is
 * all there is to do - a ban would be a lock on a room with no walls.
 *
 * **Inviting is shown even when it cannot be done.** Everything else that would
 * be refused is left out, because a menu that offers something and then says no
 * is worse than one that offers less. This is the exception: "why can I not
 * invite anybody" is a question worth answering where it is asked, and the
 * answer is that you run no servers to invite them to.
 */

/** What a reader may do about somebody, in the room they are looking at. */
export interface MemberActions {
    /** Anything at all. False for your own row: the roster is not where somebody
     *  edits themselves, and every item here reads oddly aimed at yourself. */
    readonly any: boolean;
    /** Message, call, mention, nickname, silence. Everything that needs nothing
     *  but the two of you. */
    readonly reach: boolean;
    /** Hand a group over. Only the group's owner, and only in a group: a channel
     *  belongs to whoever administers its space, and a direct message to nobody. */
    readonly transfer: boolean;
    /** Time out, remove, and - in a space - ban. */
    readonly moderate: boolean;
    /** Whether removing is out of a server rather than out of a group, which is
     *  the same act with two different sentences. */
    readonly space: boolean;
    /** Whether a ban is a thing that exists here at all. */
    readonly ban: boolean;
    /** Servers this reader could invite them to. Empty means the item is drawn
     *  disabled rather than left out - see above. */
    readonly invitable: readonly { id: string; name: string }[];
}

/** The shape of a space, as this decision needs it. */
export interface InvitableSpace {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
    /** What this reader is in it. Inviting is an administrator's act. */
    readonly access: "member" | "admin" | "owner";
}

/** The shape of a room, as this decision needs it. */
export interface MemberRoom {
    readonly id: string;
    readonly kind: string;
    readonly spaceId: string | null;
    /** Who runs a group, or null for everything that is not one. */
    readonly ownerId: string | null;
    /** Whether this reader may take somebody else's message down here, which is
     *  the same question as whether they may moderate the people in it. */
    readonly mayModerate: boolean;
}

export function memberActions(input: {
    memberId: string;
    viewerId: string;
    room: MemberRoom;
    spaces: readonly InvitableSpace[];
}): MemberActions {
    const you = input.memberId === input.viewerId;
    const group = input.room.kind === "group";
    const space = input.room.spaceId !== null;
    // A group has no roles, so the owner is the whole of its moderation.
    const yours = group && input.room.ownerId === input.viewerId;
    const moderate = !you && (input.room.mayModerate || yours);

    return {
        any: !you,
        reach: !you,
        transfer: !you && yours,
        moderate,
        space,
        // Deliberately not "moderate && space": whether a ban exists here is a
        // fact about the room, and the menu needs it separately from whether
        // this reader may reach for one.
        ban: space,
        invitable: you
            ? []
            : input.spaces
                  .filter((entry) => !entry.archived && entry.access !== "member")
                  .map((entry) => ({ id: entry.id, name: entry.name }))
    };
}
