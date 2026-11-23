/**
 * Which of a conversation's media this device fetches ahead of time, WhatsApp
 * style: photos always, videos and documents only on Wi-Fi, under a storage
 * limit. Each person can change it on this device (Chat settings).
 *
 * The rules are pure so they are tested without a browser; the fetching and the
 * Cache Storage half live in `app/(app)/chat/media-download`.
 */

import { z } from "zod";

export type MediaKind = "photos" | "videos" | "files";
export type DownloadWhen = "always" | "wifi" | "never";
export type NetworkKind = "wifi" | "cellular" | "offline";

const when = z.enum(["always", "wifi", "never"]);

/** The storage limits offered, in megabytes. */
export const MEDIA_CAPS_MB = [100, 250, 500, 1000, 2000] as const;

export const mediaDownloadSchema = z.object({
    photos: when,
    videos: when,
    files: when,
    capMb: z.number().int().refine((value) => (MEDIA_CAPS_MB as readonly number[]).includes(value))
});

export type MediaDownloadPrefs = z.infer<typeof mediaDownloadSchema>;

export const MEDIA_DOWNLOAD_DEFAULTS: MediaDownloadPrefs = {
    photos: "always",
    videos: "wifi",
    files: "wifi",
    capMb: 500
};

/** What was stored, or the defaults for anything missing or malformed. */
export function readMediaPrefs(raw: unknown): MediaDownloadPrefs {
    const merged = { ...MEDIA_DOWNLOAD_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
    const parsed = mediaDownloadSchema.safeParse(merged);
    return parsed.success ? parsed.data : MEDIA_DOWNLOAD_DEFAULTS;
}

export function mediaKindOf(contentType: string): MediaKind {
    const type = contentType.toLowerCase();
    if (type.startsWith("image/")) return "photos";
    if (type.startsWith("video/")) return "videos";
    return "files";
}

export function shouldDownload(kind: MediaKind, prefs: MediaDownloadPrefs, network: NetworkKind): boolean {
    if (network === "offline") return false;
    const rule = prefs[kind];
    return rule === "always" || (rule === "wifi" && network === "wifi");
}

/** No single file may take more than this share of the limit: one long video
 *  must not push every photo out. */
export function fitsUnderCap(size: number, capBytes: number): boolean {
    return size > 0 && size <= capBytes / 4;
}

/**
 * The network as far as the browser says. `navigator.connection.type` exists
 * on Android (Chrome and its WebView); where it is missing, a phone or tablet is
 * taken as cellular, which never spends somebody's data plan by guessing, and a
 * computer as Wi-Fi or a cable. Data Saver counts as cellular.
 */
export function networkKindOf(facts: {
    readonly online: boolean;
    readonly type?: string;
    readonly saveData?: boolean;
    readonly userAgent: string;
}): NetworkKind {
    if (!facts.online || facts.type === "none") return "offline";
    if (facts.saveData) return "cellular";
    if (facts.type === "wifi" || facts.type === "ethernet") return "wifi";
    if (facts.type && facts.type !== "unknown" && facts.type !== "other") return "cellular";
    return /Android|iPhone|iPad|iPod|Mobile/i.test(facts.userAgent) ? "cellular" : "wifi";
}

export interface KeptMedia {
    readonly url: string;
    readonly size: number;
    readonly at: number;
}

/** What to delete, oldest first, so what is left fits under the limit. */
export function mediaOverCap(entries: readonly KeptMedia[], capBytes: number): string[] {
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const doomed: string[] = [];
    for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
        if (total <= capBytes) break;
        doomed.push(entry.url);
        total -= entry.size;
    }
    return doomed;
}
