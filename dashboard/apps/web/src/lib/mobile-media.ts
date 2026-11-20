/**
 * The phone's own photos and videos, as the Polaris phone app hands them to the
 * page it hosts (`polarisMobile.mediaCall`, `DeviceMedia.java` on Android and
 * `DeviceMedia.swift` on iOS). This is what lets the composer's "+" show the
 * recent ones inline, the way Discord and Signal do, instead of sending the
 * person to the system's chooser for every photo.
 *
 * One call shape for both apps: `mediaCall(id, op, args)` answers later through
 * `window.__polarisMobileMedia(id, json)`. Absent from a browser and from an
 * app older than the feature, where the sheet keeps the system chooser.
 *
 * Client-only.
 */

import { z } from "zod";

/** What the phone lets Polaris see: everything, a selection, nothing yet asked, or a refusal. */
export type MediaAccess = "full" | "limited" | "prompt" | "denied";

const accessSchema = z.object({ access: z.enum(["full", "limited", "prompt", "denied"]) });

const itemSchema = z.object({
    id: z.string().min(1).max(512),
    video: z.boolean(),
    /** Milliseconds; 0 for a photo. */
    duration: z.number().nonnegative().default(0),
    name: z.string().max(512).default(""),
    mime: z.string().max(128).default(""),
    size: z.number().nonnegative().default(0)
});

export type DeviceMediaItem = z.infer<typeof itemSchema>;

const pageSchema = z.object({ items: z.array(itemSchema).max(500), more: z.boolean() });
const thumbSchema = z.object({ src: z.string().startsWith("data:image/") });
const chunkSchema = z.object({ data: z.string(), size: z.number().nonnegative(), done: z.boolean() });
const failureSchema = z.object({ error: z.string().max(200) });

interface MediaBridge {
    canMedia?(): boolean;
    mediaCall?(id: string, op: string, args: string): void;
}

type MediaWindow = Window & {
    polarisMobile?: MediaBridge;
    __polarisMobileMedia?: (id: string, json: string) => void;
};

/** A person deciding on the permission dialog takes as long as they take. */
const DECIDING_MS = 10 * 60_000;
/** A list or a thumbnail is local; a chunk of a photo kept only in iCloud is downloaded first. */
const LOCAL_MS = 20_000;
const CHUNK_MS = 120_000;

const waiting = new Map<string, (json: string | null) => void>();
let calls = 0;

function bridge(): MediaBridge | null {
    if (typeof window === "undefined") return null;
    const found = (window as MediaWindow).polarisMobile;
    try {
        return found?.canMedia?.() === true && typeof found.mediaCall === "function" ? found : null;
    } catch {
        return null;
    }
}

function call(app: MediaBridge, op: string, args: object, timeout: number): Promise<unknown> {
    const target = window as MediaWindow;
    target.__polarisMobileMedia ??= (id, json) => {
        const resolve = waiting.get(id);
        waiting.delete(id);
        resolve?.(json);
    };
    calls += 1;
    const id = `media-${calls}-${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            waiting.delete(id);
            reject(new Error("timeout"));
        }, timeout);
        waiting.set(id, (json) => {
            window.clearTimeout(timer);
            try {
                const parsed: unknown = JSON.parse(json ?? "null");
                const failed = failureSchema.safeParse(parsed);
                if (failed.success) reject(new Error(failed.data.error));
                else resolve(parsed);
            } catch {
                reject(new Error("unreadable"));
            }
        });
        try {
            app.mediaCall?.(id, op, JSON.stringify(args));
        } catch {
            waiting.delete(id);
            window.clearTimeout(timer);
            reject(new Error("failed"));
        }
    });
}

/** Base64 to bytes, without the copy a data: fetch would make of a large chunk. */
function bytes(base64: string): Uint8Array<ArrayBuffer> {
    const text = atob(base64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
}

export interface PhoneMedia {
    access(): Promise<MediaAccess>;
    /** Asks the phone; answers what it was given. */
    request(): Promise<MediaAccess>;
    /** iOS's "Select more photos", Android 14's selection dialog. */
    manage(): Promise<MediaAccess>;
    /** The app's page in the phone's settings, for a refusal only the settings can undo. */
    settings(): Promise<void>;
    /** Newest first. */
    list(offset: number, limit: number): Promise<{ items: DeviceMediaItem[]; more: boolean }>;
    /** A small square preview as a data: address. */
    thumb(id: string): Promise<string>;
    /** The whole photo or video, read in chunks so a long video never crosses the bridge in one piece. */
    file(item: DeviceMediaItem): Promise<File>;
}

/** The phone's gallery, or null in a browser and in an app too old to offer it. */
export function phoneMedia(): PhoneMedia | null {
    const app = bridge();
    if (!app) return null;
    const access = async (op: string, timeout: number) =>
        accessSchema.parse(await call(app, op, {}, timeout)).access;
    return {
        access: () => access("access", LOCAL_MS),
        request: () => access("request", DECIDING_MS),
        manage: () => access("manage", DECIDING_MS),
        settings: async () => {
            await call(app, "settings", {}, LOCAL_MS);
        },
        list: async (offset, limit) => pageSchema.parse(await call(app, "list", { offset, limit }, LOCAL_MS)),
        thumb: async (id) => thumbSchema.parse(await call(app, "thumb", { id }, LOCAL_MS)).src,
        file: async (item) => {
            const parts: Uint8Array<ArrayBuffer>[] = [];
            let offset = 0;
            for (;;) {
                const chunk = chunkSchema.parse(await call(app, "read", { id: item.id, offset }, CHUNK_MS));
                const piece = bytes(chunk.data);
                parts.push(piece);
                offset += piece.length;
                if (chunk.done) break;
                // A chunk that moves nothing would loop forever.
                if (piece.length === 0) throw new Error("stalled");
            }
            // The app names the file and its type as it hands it over: iOS turns a HEIC photo into a JPEG.
            return new File(parts, item.name || (item.video ? "video.mp4" : "photo.jpg"), { type: item.mime });
        }
    };
}

/** "0:42", "12:05", "1:02:09". */
export function clipLength(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
