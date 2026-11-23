/**
 * The chat screens' side of sealed messages (docs/chat-e2ee-mls.md, "Chat
 * screens"): what the composer sends and what the message list shows, through
 * this browser's MLS device.
 *
 * Inert until `configureSealedChat` is given an account, which the chat
 * provider does only when the server says `chatE2eeEnabled()` is on. Until
 * then nothing here loads the device or its WebAssembly (`mls-browser` is
 * imported on first use), and every screen sends and reads as it always did.
 *
 * The content sealed is a small versioned JSON document, so what the server
 * used to hold in the clear (the text, a live translation's original) travels
 * inside the seal; who answers whom and in which thread stays metadata, as it
 * is for the server's every other rule. What a device opens is untrusted: it
 * is parsed against the same schema the plain send is, and a row that does not
 * parse shows as one that did not open.
 *
 * Opened bodies are kept in memory for the page (at most `OPENED_LIMIT`), and
 * the sender's own text is kept the moment the server takes it, so a row never
 * blinks empty between the draft and its stored copy.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { MlsDevice } from "./mls-client";

const SEALED_CONTENT_VERSION = 1;
/** How many opened bodies this page keeps (oldest dropped first). */
export const OPENED_LIMIT = 5_000;
/** `read-sealed` takes at most this many ids per request. */
const READ_PAGE = 100;

const sealedContent = z.object({
    v: z.literal(SEALED_CONTENT_VERSION),
    body: core.chatSendSchema.shape.body,
    translation: core.chatSendSchema.shape.translation
});

/** What a sealed message carries inside its seal. */
export type SealedContent = Omit<z.infer<typeof sealedContent>, "v">;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeSealedContent(content: SealedContent): Uint8Array {
    const { body, translation } = content;
    return encoder.encode(JSON.stringify({ v: SEALED_CONTENT_VERSION, body, ...(translation ? { translation } : {}) }));
}

/** The content of an opened message, or null when it is not one this version reads. */
export function decodeSealedContent(bytes: Uint8Array): SealedContent | null {
    try {
        const parsed = sealedContent.safeParse(JSON.parse(decoder.decode(bytes)));
        if (!parsed.success) return null;
        const { body, translation } = parsed.data;
        return translation ? { body, translation } : { body };
    } catch {
        return null;
    }
}

let viewer: string | null = null;
let opening: Promise<MlsDevice> | null = null;
/** Message id -> its opened content, or null when it did not open here. */
const opened = new Map<string, SealedContent | null>();

/** Sealed chat for this account, or off (`null`). Called by the chat provider. */
export function configureSealedChat(viewerId: string | null): void {
    if (viewer === viewerId) return;
    viewer = viewerId;
    opening = null;
    opened.clear();
}

export function sealedChatActive(): boolean {
    return viewer !== null;
}

function device(): Promise<MlsDevice> {
    const userId = viewer;
    if (!userId) return Promise.reject(new Error("sealed chat is off"));
    // Imported on first use, so a page with sealed chat off never loads them.
    opening ??= Promise.all([import("./mls-browser"), import("./account-key-client")])
        .then(async ([browser, keys]) => browser.openBrowserDevice(userId, (await keys.deviceAccountHpke().catch(() => null)) ?? undefined))
        .catch((caught: unknown) => {
            opening = null;
            throw caught;
        });
    return opening;
}

function keep(id: string, content: SealedContent | null): void {
    opened.delete(id);
    opened.set(id, content);
    while (opened.size > OPENED_LIMIT) opened.delete(opened.keys().next().value as string);
}

/** What this page already opened for `id`: content, null (did not open), or undefined (not tried). */
export function openedContent(id: string): SealedContent | null | undefined {
    return opened.get(id);
}

export interface SealedSendInput extends SealedContent {
    channelId: string;
    /** The outbox key: the message id inside the seal and the send's idempotency key. */
    clientKey: string;
    parentId?: string | null;
    replyToId?: string | null;
}

/** Seal and send one message; answers the stored message's id. */
export async function sendSealedMessage(input: SealedSendInput): Promise<string> {
    const mls = await device();
    await mls.ensureGroup(input.channelId);
    const content: SealedContent = input.translation ? { body: input.body, translation: input.translation } : { body: input.body };
    const id = await mls.sendSealed(input.channelId, encodeSealedContent(content), {
        clientKey: input.clientKey,
        parentId: input.parentId ?? null,
        replyToId: input.replyToId ?? null
    });
    keep(id, content);
    return id;
}

/**
 * How a failed sealed send reads to the outbox: refused when the server
 * answered it with a refusal, else unreachable (sent again later). Never sent
 * in the clear instead.
 */
export function sealedSendFailure(caught: unknown): "refused" | "unreachable" {
    // By name and status rather than class, so this module does not load the MLS client.
    const failure = caught as { name?: unknown; status?: unknown } | null;
    const status = typeof failure?.status === "number" ? failure.status : 0;
    return failure?.name === "MlsRequestError" && status >= 400 && status < 500 && status !== 429 ? "refused" : "unreachable";
}

/**
 * Open these sealed messages of one conversation; answers what each opened
 * to (null for one that did not). Ids already opened on this page are not
 * asked for again.
 */
export async function openSealed(channelId: string, ids: readonly string[]): Promise<ReadonlyMap<string, SealedContent | null>> {
    const out = new Map<string, SealedContent | null>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
        const known = opened.get(id);
        if (known !== undefined) out.set(id, known);
        else missing.push(id);
    }
    if (!missing.length) return out;
    // Read without joining the group: the history keys sealed to this account open it.
    const mls = await device();
    for (let start = 0; start < missing.length; start += READ_PAGE) {
        const page = missing.slice(start, start + READ_PAGE);
        const rows = await mls.readSealed(channelId, page);
        const byId = new Map(rows.map((row) => [row.id, row.opened ? decodeSealedContent(row.opened) : null]));
        for (const id of page) {
            const content = byId.get(id) ?? null;
            keep(id, content);
            out.set(id, content);
        }
    }
    return out;
}
