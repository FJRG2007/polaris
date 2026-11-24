"use client";

/**
 * Drafts closed while Polaris could not be reached: kept on this device, in the
 * offline write queue every app shares (`lib/offline/app-writes`), and saved to
 * Drafts when Polaris answers - from whichever screen is open.
 *
 * One entry per draft, the newest words only (`replaceWrite`). Each carries the
 * composer's key (`draftKey`), so a new message saved twice because the first
 * answer was lost is still one draft (`saveDraftOnce`), and a draft that went on
 * to be sent is never put back to being a draft by an older copy of it.
 */

import type { DraftFields } from "./draft-saves";
import { fileDraftOnServerAction } from "./actions";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import {
    appWrites,
    forgetWrites,
    registerWriteKind,
    replaceWrite,
    type AppWrite,
    type NewWrite
} from "@/lib/offline/app-writes";

export const MAIL_DRAFT = "mail.draft";

/** A file already on the server, named so a reopened draft can show it. */
export interface KeptFile {
    readonly id: string;
    readonly name: string;
    readonly size: number;
}

/** What is kept: the draft as the composer last held it. */
export interface KeptDraft extends DraftFields {
    /** The draft on the server it writes over, when it has one yet. */
    readonly id: string | null;
    readonly draftKey: string;
    readonly files: readonly KeptFile[];
}

/** Answers worth asking again a moment later - as for a kept send. */
const TRY_LATER = new Set([408, 409, 429, 502, 503, 504]);

/** Save a kept draft. Exported for the tests. */
export async function deliverDraft(entry: Pick<AppWrite, "payload">): Promise<QueueSendResult> {
    const { files: _files, ...draft } = entry.payload as KeptDraft;
    let response: Response;
    try {
        response = await fetch("/api/mail/drafts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(draft),
            cache: "no-store"
        });
    } catch {
        return "unreachable";
    }
    if (response.ok) {
        const body = (await response.json().catch(() => null)) as { draftId?: unknown } | null;
        const draftId = typeof body?.draftId === "string" ? body.draftId : "";
        // Its copy in the mailbox's own Drafts folder, for the other devices -
        // what closing the composer does when Polaris is there.
        if (draftId) void fileDraftOnServerAction(draftId).catch(() => undefined);
        return { sent: draftId };
    }
    if (TRY_LATER.has(response.status)) return "unreachable";
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return { refused: typeof body?.error === "string" ? body.error : "" };
}

registerWriteKind(MAIL_DRAFT, deliverDraft);

/** What a kept draft is filed under: the server's draft when there is one,
 *  the composer's key until then. */
export function draftTarget(draft: Pick<KeptDraft, "id" | "draftKey">): string {
    return draft.id ?? draft.draftKey;
}

/** The write that keeps this draft, for `replaceWrite` and `keepOnUnload`. */
export function draftWrite(draft: KeptDraft): NewWrite {
    return { key: newClientKey(), kind: MAIL_DRAFT, target: draftTarget(draft), payload: draft };
}

/**
 * Keep a draft for when Polaris answers. Answers false when this device keeps
 * nothing (a private window, storage refused).
 */
export async function keepDraft(draft: KeptDraft): Promise<boolean> {
    const kept = await replaceWrite(draftWrite(draft)).catch(() => false);
    if (kept) appWrites.flush();
    return kept;
}

/** The server took this draft straight from the composer: nothing older of it
 *  is left to save. */
export function draftSaved(draft: Pick<KeptDraft, "id" | "draftKey">): void {
    void forgetWrites(MAIL_DRAFT, draft.draftKey).catch(() => undefined);
    if (draft.id) void forgetWrites(MAIL_DRAFT, draft.id).catch(() => undefined);
}
