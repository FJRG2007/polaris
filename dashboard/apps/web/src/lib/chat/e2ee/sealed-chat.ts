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
 * blinks empty between the draft and its stored copy. They are keyed by the id
 * and the time of the row's last edit, so an edited row is opened again.
 * Each one that opens is also kept in this device's search index
 * (`sealed-search-index.ts`), sealed at rest, so its words can be searched.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { MlsDevice, SealedStored } from "./mls-client";
import type { SealedSearchIndex } from "./sealed-search-index";

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
let indexing: Promise<SealedSearchIndex> | null = null;
/** Message id (and last edit) -> its opened content, or null when it did not open here. */
const opened = new Map<string, SealedContent | null>();

/** One sealed row to open: its id, and when it was last edited (absent if never). */
export type SealedRef = string | { readonly id: string; readonly editedAt?: string };

const versionKey = (id: string, editedAt?: string): string => (editedAt ? `${id}@${editedAt}` : id);
const refKey = (ref: SealedRef): string => (typeof ref === "string" ? ref : versionKey(ref.id, ref.editedAt));
const refId = (ref: SealedRef): string => (typeof ref === "string" ? ref : ref.id);

/** Sealed chat for this account, or off (`null`). Called by the chat provider. */
export function configureSealedChat(viewerId: string | null): void {
    if (viewer === viewerId) return;
    viewer = viewerId;
    opening = null;
    void indexing?.then((index) => index.close()).catch(() => undefined);
    indexing = null;
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

function searchIndex(): Promise<SealedSearchIndex> {
    const userId = viewer;
    if (!userId) return Promise.reject(new Error("sealed chat is off"));
    indexing ??= Promise.all([import("./mls-browser"), import("./sealed-search-index")])
        .then(([browser, search]) => search.SealedSearchIndex.open(browser.browserDeviceId(userId)))
        .catch((caught: unknown) => {
            indexing = null;
            throw caught;
        });
    return indexing;
}

/** Keep an opened message searchable on this device; a failure costs only the search. */
function index(channelId: string, id: string, editedAt: string | undefined, content: SealedContent | null): void {
    if (!content?.body) return;
    searchIndex()
        .then((kept) => kept.record({ id, channelId, ...(editedAt ? { editedAt } : {}), body: content.body }))
        .catch((caught: unknown) => console.warn("polaris: an opened message could not be kept searchable here:", caught));
}

/**
 * The sealed messages this device opened whose words hold `term`, newest
 * first, in `channelId` when one is named. Empty while sealed chat is off.
 */
export async function searchSealedText(term: string, channelId: string | null, limit: number): Promise<string[]> {
    if (!sealedChatActive() || !term.trim()) return [];
    return (await searchIndex()).search(term, channelId, limit);
}

/** Drop messages the server says are gone from this device's search index. */
export async function forgetSealedText(ids: readonly string[]): Promise<void> {
    if (!sealedChatActive() || !ids.length) return;
    await (await searchIndex()).forget(ids);
}

function keep(id: string, content: SealedContent | null): void {
    opened.delete(id);
    opened.set(id, content);
    while (opened.size > OPENED_LIMIT) opened.delete(opened.keys().next().value as string);
}

/** What this page already opened for `id` as last edited at `editedAt`: content, null (did not open), or undefined (not tried). */
export function openedContent(id: string, editedAt?: string): SealedContent | null | undefined {
    return opened.get(versionKey(id, editedAt));
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
    index(input.channelId, id, undefined, content);
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
 * to (null for one that did not), by id. Versions already opened on this page
 * are not asked for again.
 */
export async function openSealed(channelId: string, refs: readonly SealedRef[]): Promise<ReadonlyMap<string, SealedContent | null>> {
    const out = new Map<string, SealedContent | null>();
    const missing = new Map<string, SealedRef>();
    for (const ref of refs) {
        const known = opened.get(refKey(ref));
        if (known !== undefined) out.set(refId(ref), known);
        else missing.set(refId(ref), ref);
    }
    if (!missing.size) return out;
    // Read without joining the group: the history keys sealed to this account open it.
    const mls = await device();
    const ids = [...missing.keys()];
    for (let start = 0; start < ids.length; start += READ_PAGE) {
        const page = ids.slice(start, start + READ_PAGE);
        const rows = await mls.readSealed(channelId, page);
        const byId = new Map(rows.map((row) => [row.id, row.opened ? decodeSealedContent(row.opened) : null]));
        for (const id of page) {
            const content = byId.get(id) ?? null;
            const ref = missing.get(id)!;
            keep(refKey(ref), content);
            index(channelId, id, typeof ref === "string" ? undefined : ref.editedAt, content);
            out.set(id, content);
        }
    }
    return out;
}

export interface SealedEditInput extends SealedContent {
    channelId: string;
    messageId: string;
    /** When the version being replaced was last edited (absent if never): the one the row shows now. */
    editedAt?: string;
}

/**
 * Seal and store a new version of one of this account's sealed messages. The
 * row shows it at once and goes back to what it showed if it is refused;
 * answers when the new version was stored (the row's new `sealedEditedAt`).
 */
export async function editSealedMessage(input: SealedEditInput): Promise<string> {
    const shown = versionKey(input.messageId, input.editedAt);
    const before = opened.get(shown);
    const content: SealedContent = input.translation ? { body: input.body, translation: input.translation } : { body: input.body };
    keep(shown, content);
    try {
        const mls = await device();
        await mls.ensureGroup(input.channelId);
        const editedAt = await mls.editSealed(input.channelId, input.messageId, encodeSealedContent(content));
        keep(versionKey(input.messageId, editedAt), content);
        index(input.channelId, input.messageId, editedAt, content);
        return editedAt;
    } catch (caught) {
        if (before === undefined) opened.delete(shown);
        else keep(shown, before);
        throw caught;
    }
}

/** Open the earlier versions of a sealed message its edit history holds; null for one that does not open here. */
export async function openSealedVersions(channelId: string, messageId: string, versions: readonly SealedStored[]): Promise<(SealedContent | null)[]> {
    if (!versions.length) return [];
    const mls = await device();
    const bytes = await mls.openVersions(channelId, messageId, versions);
    return bytes.map((opened) => (opened ? decodeSealedContent(opened) : null));
}

/**
 * Take these accounts' devices out of a sealed conversation's group from this
 * browser's device (Polar, once somebody took it out), so what is said there
 * next is sealed to keys they no longer hold. A conversation this device has
 * no group for is left alone: a device that is in it will do it.
 */
export async function removeSealedAccounts(channelId: string, userIds: readonly string[]): Promise<void> {
    const mls = await device();
    if (!mls.hasGroup(channelId)) return;
    await mls.removeAccounts(channelId, [...userIds]);
}
