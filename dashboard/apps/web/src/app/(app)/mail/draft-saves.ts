/**
 * One draft's saves, one after another.
 *
 * A composer writes its draft from three places: the autosave a few seconds
 * after typing stops, Close, and Send. Each used to ask the server on its own,
 * with whatever id the screen held at that moment - and the id only reaches the
 * screen once the first save has answered. So a Close pressed while that first
 * save was still on its way wrote a second draft, and a Send pressed then queued
 * a message while its draft stayed behind in Drafts.
 *
 * Here every save waits for the one before it and starts from the id that one
 * left, so a composer only ever writes one draft. Two more rules live with it:
 *
 * - **A draft is what somebody wrote, not what the composer opened with.** A
 *   reply opens with recipients, a subject, a quote and a signature already in
 *   it; opened and closed again, it is not a draft, and nothing is written until
 *   it differs from that.
 * - **Nothing is written that is already written**, and nothing at all while a
 *   send has the draft: a save landing after the send would put the queued
 *   message back to being a draft, and it would never go.
 *
 * Pure, so the order can be checked without a screen or a server.
 */

import * as core from "@polaris/core";

/** What a draft is saved as. */
export interface DraftFields {
    readonly accountId: string;
    readonly identityId: string | null;
    readonly to: readonly core.MailAddress[];
    readonly cc: readonly core.MailAddress[];
    readonly bcc: readonly core.MailAddress[];
    readonly subject: string;
    readonly body: string;
    readonly attachmentIds: readonly string[];
}

function sameAddresses(
    left: readonly core.MailAddress[],
    right: readonly core.MailAddress[]
): boolean {
    return (
        left.length === right.length &&
        left.every((one, index) => {
            const other = right[index];
            return (
                other !== undefined &&
                one.name === other.name &&
                core.sameAddress(one.address, other.address)
            );
        })
    );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((one, index) => one === right[index]);
}

/**
 * Whether two drafts say the same thing.
 *
 * The mailbox it goes from is not part of what it says, and neither is the
 * space around the subject and the body: choosing a different From, or typing a
 * space and taking it out again, is not writing a message.
 */
export function sameWords(left: DraftFields, right: DraftFields): boolean {
    return (
        sameAddresses(left.to, right.to) &&
        sameAddresses(left.cc, right.cc) &&
        sameAddresses(left.bcc, right.bcc) &&
        left.subject.trim() === right.subject.trim() &&
        left.body.trim() === right.body.trim() &&
        sameIds(left.attachmentIds, right.attachmentIds)
    );
}

/** Whether saving one over the other would change anything. */
export function sameDraft(left: DraftFields, right: DraftFields): boolean {
    return (
        left.accountId === right.accountId &&
        left.identityId === right.identityId &&
        left.subject === right.subject &&
        left.body === right.body &&
        sameWords(left, right)
    );
}

/** Write a draft, answering with its id, or null when it could not be saved. */
export type DraftWriter = (fields: DraftFields, id: string | null) => Promise<string | null>;

export interface DraftSaves {
    /** The draft's id, once there is one. */
    readonly id: () => string | null;
    /** Save these, after whatever is already on its way. Answers with the id the
     *  draft has once it is done - null while nothing has been written. */
    readonly save: (fields: DraftFields) => Promise<string | null>;
    /** Run a task after every save already asked for, with the id they left. */
    readonly after: <T>(task: (id: string | null) => Promise<T>) => Promise<T>;
    /** The draft is this one now, holding these - what a send answers with. */
    readonly adopt: (id: string, fields: DraftFields) => void;
    /** Files the composer brought in on its own, like a forward's attachments:
     *  part of what it opened with, not something written. */
    readonly carry: (attachmentIds: readonly string[]) => void;
    /** A send has the draft: saves stand down until it is released. */
    readonly hold: () => void;
    readonly release: () => void;
}

/**
 * The saves of one opened composer.
 *
 * @param seed - What the composer opened with.
 * @param draftId - The draft it reopened, or null for a new message.
 * @param write - Where a draft is written.
 */
export function draftSaves(
    seed: DraftFields,
    draftId: string | null,
    write: DraftWriter
): DraftSaves {
    let id = draftId;
    let opened = seed;
    // What the server holds. A reopened draft holds what it was opened with; a
    // new message holds nothing yet.
    let written: DraftFields | null = draftId ? seed : null;
    let held = false;
    let tail: Promise<unknown> = Promise.resolve();

    function queue<T>(task: () => Promise<T>): Promise<T> {
        const next = tail.then(task, task);
        tail = next.catch(() => undefined);
        return next;
    }

    return {
        id: () => id,
        save: (fields) =>
            queue(async () => {
                if (held) return id;
                if (written ? sameDraft(fields, written) : sameWords(fields, opened)) return id;
                const saved = await write(fields, id).catch(() => null);
                if (saved) {
                    id = saved;
                    written = fields;
                }
                return id;
            }),
        after: (task) => queue(() => task(id)),
        adopt: (next, fields) => {
            id = next;
            written = fields;
        },
        carry: (attachmentIds) => {
            opened = { ...opened, attachmentIds: [...opened.attachmentIds, ...attachmentIds] };
        },
        hold: () => {
            held = true;
        },
        release: () => {
            held = false;
        }
    };
}
