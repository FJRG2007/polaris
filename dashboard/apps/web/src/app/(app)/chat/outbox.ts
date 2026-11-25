"use client";

/**
 * The outbox on this device: messages, and changes to messages (an edit, a
 * reaction, a delete), kept until the server takes them and sent when the
 * connection comes back. Chat's kind of the shared offline write queue
 * (`lib/offline/write-queue`), kept in the chat's own local store.
 *
 * What was written is sealed while it waits (`lib/offline/at-rest`): the
 * words of a message or an edit are kept under a device key, never in the
 * clear, and opened only to be drawn or sent. Entries kept in the clear by an
 * earlier version still open as they are.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { sendAction } from "@/lib/poll-fetch";
import { actionFailureText, runAction } from "@/lib/run-action";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import { chatStore } from "@/lib/chat/offline/chat-cache";
import { isNetworkFailure, noteRequestFailure } from "@/lib/reachability";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import { openAtRest, restKey, sealAtRest, type SealedAtRest } from "@/lib/offline/at-rest";
import { createWriteQueue, useQueueFlusher } from "@/lib/offline/write-queue";
import {
    isChatChange,
    outboxEvent,
    type ChatChange,
    type ChatQueued,
    type OutboxEntry,
    type OutboxEvent,
    type OutboxSendResult
} from "@/lib/chat/offline/outbox";

/** The words of an entry, as they are sealed while it waits. */
type Words = Pick<OutboxEntry, "body" | "translation">;

/** An entry as the store holds it: its words in `rest` when sealed. */
type Kept = ChatQueued & { readonly rest?: SealedAtRest };

const REST_KEY = "outbox";

const queue = createWriteQueue<Kept>({
    store: chatStore,
    kind: "outbox",
    lock: "polaris-chat-outbox",
    deliver: async (kept) => {
        const entry = await opened(kept);
        // Its words no longer open here (the key went with a cleared store):
        // nothing can be sent, so it is shown as not sent rather than lost quietly.
        if (!entry) return { refused: "" };
        return isChatChange(entry) ? deliverChange(entry) : deliver(entry);
    }
});

/** An entry with its words opened, or null when they do not open. */
async function opened(kept: Kept): Promise<ChatQueued | null> {
    if (!kept.rest) return kept;
    const key = await restKey(chatStore, REST_KEY);
    const words = key ? await openAtRest<Words>(key, kept.rest, kept.key) : null;
    if (!words || typeof words.body !== "string") return null;
    const { rest: _rest, ...entry } = kept;
    return { ...entry, ...words } as ChatQueued;
}

/**
 * The entry as it is kept: its words sealed. Null when they cannot be sealed
 * and must not be kept in the clear - sealed chat is on, so they are words the
 * server is never shown either.
 */
async function sealed(entry: ChatQueued): Promise<Kept | null> {
    if (!("body" in entry)) return entry;
    const key = await restKey(chatStore, REST_KEY);
    if (!key) return sealedChat.sealedChatActive() ? null : entry;
    const { translation, ...others } = entry as ChatQueued & { body: string; translation?: OutboxEntry["translation"] };
    const words: Words = translation ? { body: others.body, translation } : { body: others.body };
    return { ...others, body: "", rest: await sealAtRest(key, words, entry.key) } as Kept;
}

async function readOpened(): Promise<ChatQueued[]> {
    const all = await Promise.all((await queue.readAll()).map(async (kept) => (await opened(kept)) ?? { ...kept, body: "" }));
    return all.map((entry) => {
        const { rest: _rest, ...plain } = entry as Kept;
        return plain as ChatQueued;
    });
}

/** Told when a change is kept, which the queue itself does not announce. */
const changeListeners = new Set<(event: OutboxEvent | null) => void>();

export function subscribeOutbox(listener: (event: OutboxEvent | null) => void): () => void {
    changeListeners.add(listener);
    const stop = queue.subscribe((event) => listener(event ? outboxEvent(event) : null));
    return () => {
        changeListeners.delete(listener);
        stop();
    };
}

/** The messages waiting in one conversation (not the changes). */
export async function readOutbox(channelId: string): Promise<OutboxEntry[]> {
    return (await readOpened()).filter((entry): entry is OutboxEntry => !isChatChange(entry) && entry.channelId === channelId);
}

/** The changes waiting (or not taken) in one conversation, oldest first. */
export async function readChanges(channelId: string): Promise<ChatChange[]> {
    return (await readOpened())
        .filter((entry): entry is ChatChange => isChatChange(entry) && entry.channelId === channelId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Keep a message to send. False when this device cannot keep it (no local
 *  store, a full disk, nowhere to seal it): the caller sends it at once
 *  instead, with the same key. */
export async function enqueue(entry: Omit<OutboxEntry, "state" | "attempts" | "createdAt">): Promise<boolean> {
    // Written under sealed chat: never sent in the clear by a page without it.
    const marked = sealedChat.sealedChatActive() ? { ...entry, sealed: true } : entry;
    const kept = await sealed(marked as OutboxEntry).catch(() => null);
    return kept ? queue.enqueue(kept as Omit<Kept, "state" | "attempts" | "createdAt">) : false;
}

/** Put a not-sent entry back in line, as it is kept (its words stay sealed). */
export async function retry(entry: ChatQueued): Promise<void> {
    const stored = (await queue.readAll()).find((candidate) => candidate.key === entry.key);
    if (stored) await queue.retry(stored);
}

export function discard(key: string): Promise<void> {
    return queue.discard(key);
}

/** A message on its way: an outbox entry, or a thread answer (`parentId`, no key of its own). */
type Sendable = Pick<OutboxEntry, "channelId" | "body" | "replyToId" | "translation" | "sealed"> & { key?: string; parentId?: string | null };

/**
 * The ordinary send, through its route (`/api/chat/send`) rather than as a
 * server action: a tab's actions run one at a time behind its navigations, and
 * a message waited on its clock behind every typing ping and read mark the
 * screen had sent before it. Answers what `sendAction` answers.
 */
export function postMessage(input: {
    channelId: string;
    body: string;
    parentId?: string;
    replyToId?: string | null;
    translation?: OutboxEntry["translation"];
    clientKey?: string;
}): Promise<{ id?: string; error?: string }> {
    return sendAction<{ id?: string; error?: string }>("/api/chat/send", input);
}

/**
 * Send one message now, for a caller that could not keep it in the outbox:
 * answers as `sendAction` does and throws when the server cannot be reached.
 * With sealed chat off it is `sendAction` itself.
 */
export async function sendNow(entry: Sendable): Promise<{ id?: string; error?: string }> {
    if (!(await sealedChat.sealsSendsIn(entry.channelId)))
        return postMessage({
            channelId: entry.channelId,
            body: entry.body,
            ...(entry.parentId ? { parentId: entry.parentId } : {}),
            replyToId: entry.replyToId,
            translation: entry.translation,
            ...(entry.key ? { clientKey: entry.key } : {})
        });
    const result = await deliver(entry);
    if (result === "unreachable" || result === "held") throw new Error("the sealed message could not be sent");
    return "sent" in result ? { id: result.sent } : { error: result.refused };
}

/**
 * Send one kept message: sealed through this browser's MLS device when sealed
 * chat is on (never in the clear instead), else the ordinary send.
 */
export async function deliver(entry: Sendable): Promise<OutboxSendResult> {
    if (entry.sealed && !sealedChat.sealedChatActive()) return "held";
    let seals: boolean;
    try {
        seals = await sealedChat.sealsSendsIn(entry.channelId);
    } catch (caught) {
        console.warn("polaris: a sealed message was not sent yet:", caught);
        return "unreachable";
    }
    if (seals) {
        try {
            const id = await sealedChat.sendSealedMessage({
                channelId: entry.channelId,
                body: entry.body,
                clientKey: entry.key ?? crypto.randomUUID(),
                parentId: entry.parentId ?? null,
                replyToId: entry.replyToId,
                ...(entry.translation ? { translation: entry.translation } : {})
            });
            return { sent: id };
        } catch (caught) {
            if (sealedChat.sealedSendFailure(caught) === "refused") return { refused: "" };
            console.warn("polaris: a sealed message was not sent yet:", caught);
            return "unreachable";
        }
    }
    try {
        const result = await postMessage({
            channelId: entry.channelId,
            body: entry.body,
            replyToId: entry.replyToId,
            translation: entry.translation,
            clientKey: entry.key
        });
        return result.id ? { sent: result.id } : { refused: result.error ?? "" };
    } catch {
        return "unreachable";
    }
}

/** A change as a screen asks for it. */
export type ChangeRequest =
    | {
          readonly op: "edit";
          readonly channelId: string;
          readonly messageId: string;
          readonly body: string;
          readonly sealed?: boolean;
          readonly editedAt?: string;
      }
    | { readonly op: "react"; readonly channelId: string; readonly messageId: string; readonly emoji: string; readonly on: boolean; }
    | { readonly op: "delete"; readonly channelId: string; readonly messageId: string; };

/** What a change answered when it was sent now (`sealedEditedAt` for a sealed edit, `on` for a reaction). */
export interface ChangeAnswer {
    readonly sealedEditedAt?: string;
    readonly on?: boolean;
}

/** Send one change now; throws when the server cannot be reached, answers `{ refused }` when it said no. */
async function sendChange(change: ChangeRequest): Promise<ChangeAnswer | { refused: string; }> {
    if (change.op === "edit" && change.sealed) {
        // Sealed only by a page that has the device open: anywhere else it waits.
        if (!sealedChat.sealedChatActive()) throw new TypeError("sealed chat is not open on this page");
        try {
            const sealedEditedAt = await sealedChat.editSealedMessage({
                channelId: change.channelId,
                messageId: change.messageId,
                body: change.body,
                ...(change.editedAt ? { editedAt: change.editedAt } : {})
            });
            return { sealedEditedAt };
        } catch (caught) {
            // Not answered (or not by the server): sent again later, never in the clear.
            if (isNetworkFailure(caught) || sealedChat.sealedSendFailure(caught) === "unreachable") throw caught;
            const text = (caught as { text?: unknown; } | null)?.text;
            return { refused: typeof text === "string" ? text : "" };
        }
    }
    if (change.op === "edit") {
        const result = await actions.editAction(
            { messageId: change.messageId, body: change.body },
            sealedChat.sealedChatActive()
        );
        return result.error ? { refused: result.error } : {};
    }
    if (change.op === "react") {
        const result = await actions.reactAction({ messageId: change.messageId, emoji: change.emoji, on: change.on });
        return result.error ? { refused: result.error } : { on: result.on ?? change.on };
    }
    const result = await actions.deleteMessageAction(change.messageId);
    return result.error ? { refused: result.error } : {};
}

async function deliverChange(change: ChatChange): Promise<QueueSendResult> {
    // Sealed only by a page that has the device open: one that has not waits for
    // the next page that does, rather than counting as a failed attempt.
    if (change.op === "edit" && change.sealed && !sealedChat.sealedChatActive()) return "held";
    try {
        const answer = await sendChange(change);
        return "refused" in answer ? { refused: answer.refused } : { sent: change.messageId };
    } catch (caught) {
        noteRequestFailure(caught);
        return "unreachable";
    }
}

/**
 * Keep a change in line behind what is waiting for the same message. An edit
 * behind an edit, or the same reaction behind itself, replaces it (the newer
 * one is what the reader wants, and an edit keeps the version the first one
 * replaced); a delete takes everything else waiting for the message with it.
 */
async function keepChange(change: ChangeRequest): Promise<boolean> {
    const run = async (): Promise<boolean> => {
        const waiting = (await readChanges(change.channelId)).filter(
            (entry) => entry.messageId === change.messageId && entry.state === "pending"
        );
        const last = waiting.at(-1);
        const sameKind =
            last !== undefined &&
            last.op === change.op &&
            (change.op !== "react" || (last.op === "react" && last.emoji === change.emoji));
        const replaced = change.op === "delete" ? waiting : sameKind ? [last] : [];
        const first = replaced[0];
        const next =
            change.op === "edit" && first?.op === "edit"
                ? { ...change, sealed: first.sealed, editedAt: first.editedAt }
                : change;
        const entry = await sealed({ ...next, key: newClientKey(), state: "pending", attempts: 0, createdAt: "" } as ChatChange);
        if (!entry) return false;
        const { state: _state, attempts: _attempts, createdAt: _createdAt, ...fields } = entry as Kept;
        if (!(await queue.enqueue(fields as Omit<Kept, "state" | "attempts" | "createdAt">))) return false;
        for (const old of replaced) await chatStore.forget("outbox", old.key);
        return true;
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const owner = chatStore.owner();
    return locks && owner ? locks.request(`polaris-chat-changes:${owner}`, run) : run();
}

/**
 * Change a message now, or keep the change for when Polaris answers. Tried at
 * once when nothing for the same message is waiting and the device has a
 * network; kept when it is offline or the request found no server. Answers
 * what the server answered, `{ queued: true }` when it was kept (drawn as
 * done meanwhile, with the clock), `{ error }` when the server refused (its
 * words, empty when it gave none), and
 * null when it failed otherwise (`onFailure` was told).
 */
export async function changeMessage(
    change: ChangeRequest,
    onFailure: (message: string) => void
): Promise<(ChangeAnswer & { queued?: true; }) | { error: string; } | null> {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const behind = (await readChanges(change.channelId).catch(() => [])).some(
        (entry) => entry.messageId === change.messageId && entry.state === "pending"
    );
    if (!offline && !behind) {
        let unanswered = false;
        const answer = await runAction(
            () =>
                sendChange(change).catch((caught: unknown) => {
                    // Not answered: kept below. Anything else fails as it always did.
                    if (!isNetworkFailure(caught)) throw caught;
                    noteRequestFailure(caught);
                    unanswered = true;
                    return null;
                }),
            onFailure
        );
        if (!unanswered) {
            if (!answer) return null;
            return "refused" in answer ? { error: answer.refused } : answer;
        }
    }
    if (await keepChange(change).catch(() => false)) {
        for (const listener of changeListeners) listener(null);
        flushOutbox();
        return { queued: true };
    }
    onFailure(actionFailureText());
    return null;
}

/** The changes waiting (or not taken) in one conversation, kept current. */
export function useChatChanges(channelId: string): readonly ChatChange[] {
    const [changes, setChanges] = useState<readonly ChatChange[]>([]);
    useEffect(() => {
        let live = true;
        const reload = (): void =>
            void readChanges(channelId).then(
                (next) => live && setChanges((current) => (current.length === 0 && next.length === 0 ? current : next)),
                () => undefined
            );
        reload();
        const stop = subscribeOutbox((event) => {
            if (!event || event.channelId === channelId) reload();
        });
        return () => {
            live = false;
            stop();
        };
    }, [channelId]);
    return changes;
}
/** Send whatever is waiting, oldest first. Calls during a run ask for one more. */
export function flushOutbox(): void {
    queue.flush();
}

/** Mounted once with the chat: sends on open, when the network returns and
 *  when the app comes back to the foreground. */
export function useOutboxFlusher(viewerId: string): void {
    useQueueFlusher(flushOutbox, [viewerId]);
}
