"use client";

/**
 * Media fetched ahead of time into Cache Storage, so the photos (and, by the
 * setting, videos and documents) of recent messages are there with no network.
 * The rules are in `lib/chat/offline/media-download`.
 *
 * Only the page writes this cache. The service worker reads it when the network
 * cannot answer for an attachment, and never stores anything in it itself.
 * Deleted on sign-out and on an account change (`account-switch`), and never
 * holds a view-once attachment.
 */

import { useSyncExternalStore } from "react";
import type { ChatMessageView } from "@/lib/chat/messages";
import * as rules from "@/lib/chat/offline/media-download";
import { attachmentImageUrl } from "./message-gallery";

/** Read by `account-switch` and `public/sw.js`. */
export const MEDIA_CACHE = "polaris-chat-media";
export const PREFS_KEY = "polaris.chat.mediaDownload";
const SIZE_HEADER = "x-polaris-size";
const AT_HEADER = "x-polaris-at";

const listeners = new Set<() => void>();
let snapshot: { raw: string | null; prefs: rules.MediaDownloadPrefs } | null = null;

function storedPrefs(): rules.MediaDownloadPrefs {
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(PREFS_KEY);
    } catch {
        // Blocked storage: the defaults.
    }
    if (snapshot && snapshot.raw === raw) return snapshot.prefs;
    let parsed: unknown = null;
    try {
        parsed = raw ? JSON.parse(raw) : null;
    } catch {
        parsed = null;
    }
    snapshot = { raw, prefs: rules.readMediaPrefs(parsed) };
    return snapshot.prefs;
}

export function mediaPrefs(): rules.MediaDownloadPrefs {
    return typeof window === "undefined" ? rules.MEDIA_DOWNLOAD_DEFAULTS : storedPrefs();
}

export function setMediaPrefs(next: rules.MediaDownloadPrefs): void {
    try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(rules.readMediaPrefs(next)));
    } catch {
        // Blocked storage: the change lasts for this page only.
    }
    for (const listener of listeners) listener();
    void trimMedia();
}

export function useMediaPrefs(): rules.MediaDownloadPrefs {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            const onStorage = (event: StorageEvent) => event.key === PREFS_KEY && listener();
            window.addEventListener("storage", onStorage);
            return () => {
                listeners.delete(listener);
                window.removeEventListener("storage", onStorage);
            };
        },
        mediaPrefs,
        () => rules.MEDIA_DOWNLOAD_DEFAULTS
    );
}

export function currentNetwork(): rules.NetworkKind {
    const connection = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } })
        .connection;
    return rules.networkKindOf({
        online: navigator.onLine,
        type: connection?.type,
        saveData: connection?.saveData,
        userAgent: navigator.userAgent
    });
}

function openCache(): Promise<Cache> | null {
    try {
        return typeof caches === "undefined" ? null : caches.open(MEDIA_CACHE);
    } catch {
        return null;
    }
}

async function keptEntries(cache: Cache): Promise<rules.KeptMedia[]> {
    const keys = await cache.keys();
    const answers = await Promise.all(keys.map((key) => cache.match(key)));
    return keys.map((key, index) => ({
        url: key.url,
        size: Number(answers[index]?.headers.get(SIZE_HEADER) ?? 0),
        at: Number(answers[index]?.headers.get(AT_HEADER) ?? 0)
    }));
}

/** Oldest first, until what is kept fits under the limit. */
export async function trimMedia(): Promise<void> {
    const cache = await openCache()?.catch(() => null);
    if (!cache) return;
    const doomed = rules.mediaOverCap(await keptEntries(cache), mediaPrefs().capMb * 1024 * 1024);
    await Promise.all(doomed.map((url) => cache.delete(url)));
}

export async function mediaUsage(): Promise<{ bytes: number; files: number }> {
    const cache = await openCache()?.catch(() => null);
    if (!cache) return { bytes: 0, files: 0 };
    const entries = await keptEntries(cache);
    return { bytes: entries.reduce((sum, entry) => sum + entry.size, 0), files: entries.length };
}

export async function clearMedia(): Promise<void> {
    if (typeof caches !== "undefined") await caches.delete(MEDIA_CACHE).catch(() => false);
}

const queued = new Set<string>();
let draining: Promise<void> | null = null;
const queue: { url: string; size: number }[] = [];

async function drain(): Promise<void> {
    const cache = await openCache()?.catch(() => null);
    if (!cache) {
        queue.length = 0;
        queued.clear();
        return;
    }
    while (queue.length > 0) {
        const next = queue.shift()!;
        try {
            if (await cache.match(next.url)) continue;
            const answer = await fetch(next.url, { credentials: "same-origin" });
            if (!answer.ok || answer.redirected || answer.type !== "basic") continue;
            const body = await answer.blob();
            await cache.put(
                next.url,
                new Response(body, {
                    headers: {
                        "content-type": answer.headers.get("content-type") ?? "application/octet-stream",
                        [SIZE_HEADER]: String(body.size),
                        [AT_HEADER]: String(Date.now())
                    }
                })
            );
        } catch {
            // The network went or the disk is full: whatever is left waits for
            // the next conversation opened.
            break;
        } finally {
            queued.delete(next.url);
        }
    }
    queue.length = 0;
    queued.clear();
    await trimMedia().catch(() => undefined);
}

/** Fetch the media of these messages that the reader's setting allows now. */
export function prefetchMedia(messages: readonly ChatMessageView[]): void {
    if (typeof window === "undefined") return;
    const prefs = mediaPrefs();
    const network = currentNetwork();
    const capBytes = prefs.capMb * 1024 * 1024;
    for (const message of messages) {
        if (message.deleted || message.blocked) continue;
        for (const file of message.attachments) {
            // Shown once and gone: never kept on a device.
            if (file.viewOnce) continue;
            if (!rules.shouldDownload(rules.mediaKindOf(file.contentType), prefs, network)) continue;
            if (!rules.fitsUnderCap(file.size, capBytes)) continue;
            const url = new URL(attachmentImageUrl(file.id), window.location.origin).href;
            if (queued.has(url)) continue;
            queued.add(url);
            queue.push({ url, size: file.size });
        }
    }
    if (queue.length === 0 || draining) return;
    draining = drain().finally(() => {
        draining = null;
    });
}
