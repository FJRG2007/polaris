/**
 * The conversation list as the client holds it: what the server last said,
 * the writes this reader made that the server has not confirmed yet, and the
 * one order every list draws it in.
 *
 * Two things went wrong without it. The rail sorted by `lastMessageAt` but
 * drew the time and the preview of `last`, which are not the same message (a
 * thread reply, a whisper meant for somebody else or a message that vanished
 * moves the first and not the second), so a row could sit at the top showing
 * a message from hours ago. And every answer replaced the list whole, in the
 * order the answers arrived rather than the order they were asked for, so a
 * slow read started before a message landed could put the list back the way
 * it was after a newer one had already moved it. A phone tab that slept
 * through the stream then had nothing to move it again until a reload.
 *
 * So: one sort key, `activityAt`, which is what the row shows; a ticket per
 * read, and an answer older than the one on screen is dropped; and a reader's
 * own changes laid over the server's rows until an answer asked for after the
 * write finished arrives - which is what makes them instant without the old
 * value flickering back in between.
 */

import * as core from "@polaris/core";
import type { ChatChannelView } from "@/lib/chat/chat-service";

type Row = Pick<ChatChannelView, "id" | "pinned" | "lastMessageAt" | "last">;

/**
 * When a conversation last said something, as its row shows it.
 *
 * The newest message the row draws when there is one - a direct message or a
 * group - and the channel's own stamp otherwise (a channel in a space, or a
 * locked conversation whose message is withheld). Never a mix: the order and
 * the time on the row come from the same field.
 */
export function activityAt(row: Pick<Row, "lastMessageAt" | "last">): string {
    return row.last?.at ?? row.lastMessageAt ?? "";
}

/** Newest first. Ties broken by id so two rows never swap between renders. */
export function byActivity(left: Row, right: Row): number {
    return (
        activityAt(right).localeCompare(activityAt(left)) || left.id.localeCompare(right.id)
    );
}

/** Pinned first, then newest first - the order of the direct messages. */
export function byPinThenActivity(left: Row, right: Row): number {
    return Number(right.pinned) - Number(left.pinned) || byActivity(left, right);
}

/** One write laid over the server's rows until the server has caught up with it. */
interface Overlay {
    readonly patches: ReadonlyMap<string, Partial<ChatChannelView>>;
    /** The last ticket issued when the write finished, or null while it is in
     *  flight. An answer with a later ticket was asked for after it and
     *  already reflects it. */
    settledAt: number | null;
}

export class ConversationList {
    private base: readonly ChatChannelView[] = [];
    private issued = 0;
    private applied = 0;
    private writes = 0;
    private readonly overlays = new Map<number, Overlay>();

    /** What the server last said, without this reader's pending writes - the
     *  copy that is kept on the device. */
    get server(): readonly ChatChannelView[] {
        return this.base;
    }

    /** What the list draws: the server's rows with every pending write on top. */
    get rows(): readonly ChatChannelView[] {
        if (this.overlays.size === 0) return this.base;
        return this.base.map((row) => {
            let drawn = row;
            for (const overlay of this.overlays.values()) {
                const patch = overlay.patches.get(row.id);
                if (patch) drawn = { ...drawn, ...patch };
            }
            return drawn;
        });
    }

    /** A ticket for a read about to be sent. Taken when it is sent, not when
     *  it was first wanted, so a coalesced read still counts as a new one. */
    ask(): number {
        this.issued += 1;
        return this.issued;
    }

    /** A copy kept on the device, drawn before any answer. Never outranks one. */
    seed(rows: readonly ChatChannelView[]): void {
        if (this.applied === 0) this.base = rows;
    }

    /**
     * An answer to the read holding `ticket`. False, and nothing changes, when
     * an answer to a later read is already on screen.
     */
    receive(rows: readonly ChatChannelView[], ticket: number): boolean {
        if (ticket < this.applied) return false;
        this.applied = ticket;
        this.base = rows;
        for (const [id, overlay] of this.overlays) {
            if (overlay.settledAt !== null && ticket > overlay.settledAt) this.overlays.delete(id);
        }
        return true;
    }

    /** Start a write: its patches show at once. Returns the handle to settle
     *  or undo it with. */
    begin(patches: ReadonlyMap<string, Partial<ChatChannelView>>): number {
        this.writes += 1;
        this.overlays.set(this.writes, { patches, settledAt: null });
        return this.writes;
    }

    /** The server took it. It stays drawn until a read asked for after now lands. */
    settle(write: number): void {
        const overlay = this.overlays.get(write);
        if (overlay) overlay.settledAt = this.issued;
    }

    /** The server refused it: the rows go back to what the server says. */
    undo(write: number): void {
        this.overlays.delete(write);
    }
}

/**
 * What a mute of `minutes` reads as on the row - `null` lifts it. The same
 * arithmetic the server stores, so the patch and the answer agree.
 */
export function mutedFields(
    minutes: number | null,
    now = new Date()
): Pick<ChatChannelView, "muted" | "mutedUntil"> {
    if (minutes === null) return { muted: false, mutedUntil: null };
    return { muted: true, mutedUntil: core.muteEndsAt(minutes, now)?.toISOString() ?? null };
}
