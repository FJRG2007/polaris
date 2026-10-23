/**
 * Polar in the side panel when Polaris does not answer.
 *
 * The chat is the deployment's own page in a frame, so a Polaris that is down
 * is a panel with nothing in it. While it is up, the frame hands the panel a
 * copy of the conversation on screen (`snapshot`, addressed to the extension's
 * origin only); the panel keeps the last few, per Polaris and per account, and
 * draws them read-only when the frame cannot load - with what somebody types
 * meanwhile kept as a draft for when it is back.
 *
 * Mirrors the embed's `snapshotFrom` (`apps/web/src/lib/polar/embed-bridge.ts`):
 * the shape and the caps are the same, and a test holds the two to each other.
 */

import { FROM_EMBED } from "./polar-panel";

/** The caps the embed cuts a conversation to. */
export const SNAPSHOT_MESSAGES = 40;
export const SNAPSHOT_TEXT = 8000;
export const SNAPSHOT_TITLE = 120;

/** How many conversations are kept, and how much of the browser's storage. */
export const KEPT_CONVERSATIONS = 10;
export const KEPT_BYTES = 512 * 1024;

/** Where the copy lives, one per Polaris, and the draft, one per account on it. */
export const keptKey = (server: string): `local:${string}` =>
    `local:polar.kept.${new URL(server).origin}`;
export const draftKey = (server: string, account: string): `local:${string}` =>
    `local:polar.draft.${new URL(server).origin}.${account}`;

/** Whether a key in the browser's local storage is a copy or a draft. */
export const isOfflineKey = (key: string): boolean =>
    key.startsWith("polar.kept.") || key.startsWith("polar.draft.");

export interface KeptMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

export interface KeptConversation {
    readonly id: string;
    readonly title: string;
    /** When it was copied, ms. */
    readonly at: number;
    readonly messages: readonly KeptMessage[];
}

export interface Kept {
    readonly account: string;
    readonly conversations: readonly KeptConversation[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, most: number, least = 0): value is string =>
    typeof value === "string" && value.length >= least && value.length <= most;

function readMessage(value: unknown): KeptMessage | null {
    if (!isRecord(value)) return null;
    if (value.role !== "user" && value.role !== "assistant") return null;
    if (!boundedString(value.text, SNAPSHOT_TEXT)) return null;
    return { role: value.role, text: value.text };
}

/** A conversation in the snapshot's shape, or null for anything else. */
export function readConversation(value: unknown): KeptConversation | null {
    if (!isRecord(value)) return null;
    const { id, title, at, messages } = value;
    if (!boundedString(id, 64, 1) || !boundedString(title, SNAPSHOT_TITLE)) return null;
    if (typeof at !== "number" || !Number.isInteger(at) || at < 0) return null;
    if (!Array.isArray(messages) || messages.length > SNAPSHOT_MESSAGES) return null;
    const read = messages.map(readMessage);
    if (read.some((message) => message === null)) return null;
    return { id, title, at, messages: read as KeptMessage[] };
}

/**
 * The snapshot in a message, only from the panel's own frame on the
 * deployment's origin and only in the embed's shape; null for anything else.
 */
export function snapshotFrom(
    event: { data: unknown; origin: string; source: unknown },
    frame: unknown,
    server: string
): { account: string; conversation: KeptConversation } | null {
    if (event.source !== frame || event.origin !== new URL(server).origin) return null;
    const data = event.data;
    if (!isRecord(data) || data.source !== FROM_EMBED || data.kind !== "snapshot") return null;
    if (!boundedString(data.account, 64, 1)) return null;
    const conversation = readConversation(data.conversation);
    return conversation ? { account: data.account, conversation } : null;
}

/** The stored copy as it is now, read total: anything malformed is dropped. */
export function readKept(value: unknown): Kept | null {
    if (!isRecord(value) || !boundedString(value.account, 64, 1)) return null;
    const list = Array.isArray(value.conversations) ? value.conversations : [];
    const conversations = list
        .map(readConversation)
        .filter((one): one is KeptConversation => one !== null)
        .slice(0, KEPT_CONVERSATIONS);
    return { account: value.account, conversations };
}

/** The copy only for the account it was kept for; nothing for another or none. */
export function keptFor(kept: Kept | null, account: string | null): Kept | null {
    return kept && account && kept.account === account ? kept : null;
}

const sizeOf = (kept: Kept): number => new TextEncoder().encode(JSON.stringify(kept)).length;

/**
 * The copy with this conversation in it: newest first, replacing its older
 * copy, at most `KEPT_CONVERSATIONS` and `KEPT_BYTES`. Another account's copy
 * is replaced whole, never mixed.
 */
export function remember(kept: Kept | null, account: string, conversation: KeptConversation): Kept {
    const before = kept && kept.account === account ? kept.conversations : [];
    let conversations = [conversation, ...before.filter((one) => one.id !== conversation.id)].slice(
        0,
        KEPT_CONVERSATIONS
    );
    while (conversations.length > 1 && sizeOf({ account, conversations }) > KEPT_BYTES) {
        conversations = conversations.slice(0, -1);
    }
    return { account, conversations };
}

/** How long before the next try, ms: 5 s, doubling, at most a minute. */
export function retryDelay(attempt: number): number {
    return Math.min(60_000, 5000 * 2 ** Math.max(0, attempt));
}

export type Block =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "code"; readonly text: string };

/** A message cut into its fenced code blocks and the text around them. */
export function blocksOf(text: string): Block[] {
    const blocks: Block[] = [];
    const parts = text.split(/^```[^\n]*$/m);
    parts.forEach((part, at) => {
        const trimmed = at % 2 === 1 ? part.replace(/^\n|\n$/g, "") : part.trim();
        if (!trimmed) return;
        // An odd part sits between two fences; an unclosed last one is still code.
        blocks.push({ kind: at % 2 === 1 ? "code" : "text", text: trimmed });
    });
    return blocks;
}
