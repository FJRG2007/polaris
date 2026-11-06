import * as core from "@polaris/core";

/**
 * Ticks in a conversation of more than two, worked out from the read marks every
 * member already has.
 *
 * Nothing per message is stored for this: `ChatChannelMember.lastReadAt` and
 * `lastDeliveredAt` say how far each person has got, and a message is read by
 * somebody exactly when their mark is at or past it. So "who has read this" is
 * one row per member, never one row per member per message.
 *
 * Pure, so the rules can be asserted without a database.
 */

/**
 * The largest conversation that gets ticks at all. A group cannot be bigger than
 * `MAX_GROUP_MEMBERS`, so in practice every group has them; the cap is what keeps
 * a conversation that somehow is bigger - an old row, a direct write - from
 * turning every page into a lookup of every member.
 */
export const GROUP_RECEIPT_MAX_MEMBERS = core.MAX_GROUP_MEMBERS;

/** How far one member has got, and whether their ticks are the reader's to see. */
export interface MemberMark {
    readonly userId: string;
    readonly readAt: Date | null;
    readonly deliveredAt: Date | null;
    /** False when either side's read-receipt setting withholds them. Such a
     *  member is unknown: never counted as having read anything. */
    readonly allowed: boolean;
}

/** Where one member stands with one message. */
export type MemberReceipt = core.MessageReceipt | "unknown";

/**
 * How far somebody has read, as far as the ticks are concerned: the furthest
 * they have ever got. Marking a conversation unread moves `lastReadAt` back and
 * leaves `lastSeenAt` where it was; a row from before `lastSeenAt` existed has
 * only the first.
 */
export function seenAt(member: {
    readonly lastReadAt: Date | null;
    readonly lastSeenAt: Date | null;
}): Date | null {
    const { lastReadAt: read, lastSeenAt: seen } = member;
    if (!read || !seen) return seen ?? read;
    return seen > read ? seen : read;
}

/** One member's standing with one message. */
export function memberReceiptAt(mark: MemberMark, createdAt: Date): MemberReceipt {
    if (!mark.allowed) return "unknown";
    if (mark.readAt && mark.readAt >= createdAt) return "read";
    if (mark.deliveredAt && mark.deliveredAt >= createdAt) return "delivered";
    return "sent";
}

/**
 * The tick under a message: the least any other member has got to. Read only
 * once every one of them has read it, delivered once every one has it. A member
 * whose ticks are withheld holds it at delivered, because "everyone has read
 * this" would otherwise be a claim about somebody who chose not to say - and
 * holding it lower would say the message never reached the others.
 */
export function receiptAmong(marks: readonly MemberMark[], createdAt: Date): core.MessageReceipt {
    let least: core.MessageReceipt = "read";
    for (const mark of marks) {
        const state = memberReceiptAt(mark, createdAt);
        if (state === "sent") return "sent";
        if (state === "unknown" || state === "delivered") least = "delivered";
    }
    return marks.length === 0 ? "sent" : least;
}

/**
 * Whether a conversation with this many other members gets ticks, and with
 * them the per-member list. None when nobody's ticks are visible: a reader who
 * turned their own off sees nobody's, the same reciprocity a one-to-one has.
 */
export function ticksShown(marks: readonly MemberMark[]): boolean {
    if (marks.length === 0 || marks.length > GROUP_RECEIPT_MAX_MEMBERS - 1) return false;
    return marks.some((mark) => mark.allowed);
}

/** One member as the who-has-read list shows them. */
export interface NamedReceipt {
    readonly id: string;
    readonly name: string;
    readonly state: MemberReceipt;
}

const ORDER: Record<MemberReceipt, number> = { read: 0, delivered: 1, sent: 2, unknown: 3 };

/** Every member's standing with one message: the ones who read it first, the
 *  ones whose ticks are withheld last, alphabetical within each. */
export function readersAt(
    marks: readonly (MemberMark & { readonly name: string })[],
    createdAt: Date
): NamedReceipt[] {
    return marks
        .map((mark) => ({
            id: mark.userId,
            name: mark.name,
            state: memberReceiptAt(mark, createdAt)
        }))
        .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
