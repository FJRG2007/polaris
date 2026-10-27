/**
 * Telling open tabs that a notice above the page changed.
 *
 * The banners at the top of every screen - an administrator's announcement, a
 * disk running out, the server's address moving - were read when the page was
 * drawn, or on a timer minutes apart, so a maintenance notice published now
 * reached the people it was for whenever they next reloaded. Every writer that
 * changes one of them is in this server (an action, or a job on the in-process
 * scheduler), so the same in-process bus access and language changes ride
 * carries these too, on the same stream (`/api/access/stream`).
 *
 * A frame names the notice and nothing else. The tab that hears it reads the
 * notice again through its own session and checks, so a frame can never show
 * somebody a banner that was not meant for them.
 */

import type { Permission } from "@polaris/core";
import type { AudienceSpec } from "@/lib/announcements/schema";
import { matchesAudience, type Membership } from "@/lib/announcements/audience";

/** Which notice moved. */
export type NoticeTopic = "announcements" | "disk" | "lan";

/** Who a change is for: every account, whoever holds a capability, or any of these audiences. */
export type NoticeReach =
    | "everyone"
    | { permission: Permission }
    | { audiences: readonly AudienceSpec[] };

export interface NoticeChange {
    readonly topic: NoticeTopic;
    readonly reach: NoticeReach;
}

/** The account a stream serves. */
export interface NoticeReader {
    id: string;
    isAdmin: boolean;
}

/** What a reach may need to know about the reader, each read only when asked. */
export interface NoticeLookups {
    membership: () => Promise<Membership | null>;
    can: (permission: Permission) => Promise<boolean>;
    /** The account an administrator is looking at Polaris as, if any. */
    viewing: () => Promise<string | null>;
}

type Listener = (change: NoticeChange) => void;

/** On globalThis rather than in a module binding: the action that writes a change
 *  and the stream that delivers it may be different copies of this module. */
const REGISTRY = Symbol.for("polaris.notices.live");

function listeners(): Set<Listener> {
    const holder = globalThis as { [REGISTRY]?: Set<Listener> };
    return (holder[REGISTRY] ??= new Set());
}

/** Announce a change. Never throws and never awaited by the write that raised it. */
export function publishNoticeChange(change: NoticeChange): void {
    for (const listener of listeners()) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeNotices(listener: Listener): () => void {
    const held = listeners();
    held.add(listener);
    return () => {
        held.delete(listener);
    };
}

/**
 * Whether a change is this reader's business. An administrator hears every
 * change that is about more than particular people: they are the ones who view
 * Polaris as somebody else. A change naming only particular people - one
 * reader closing a banner - reaches an administrator only when it names them or
 * the account they are viewing as, or every administrator's tab would read
 * again each time anybody closed one. Lookups run only when the answer needs
 * them.
 */
export async function noticeReaches(
    change: NoticeChange,
    reader: NoticeReader,
    lookups: NoticeLookups
): Promise<boolean> {
    if (change.reach === "everyone") return true;
    if ("permission" in change.reach) return reader.isAdmin || (await lookups.can(change.reach.permission));
    const audiences = change.reach.audiences;
    if (audiences.some((one) => one.everyone || one.userIds.includes(reader.id))) return true;
    const grouped = audiences.filter(
        (one) => one.roleIds.length > 0 || one.groupIds.length > 0 || one.orgIds.length > 0
    );
    if (reader.isAdmin) {
        if (grouped.length > 0) return true;
        const viewed = await lookups.viewing();
        return viewed !== null && audiences.some((one) => one.userIds.includes(viewed));
    }
    if (grouped.length === 0) return false;
    const member = await lookups.membership();
    return grouped.some((one) => matchesAudience(member, one));
}
