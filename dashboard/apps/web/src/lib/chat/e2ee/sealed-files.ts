/**
 * Chat files sealed in this browser (docs/chat-e2ee-proposal.md 10b,
 * `@polaris/chat-crypto/file-content`): what the composer uploads for a
 * sealed conversation, and what a reader's page opens to draw one.
 *
 * Sending: each file is sealed under a fresh key and uploaded as an opaque
 * blob (`?sealed=1`, stored as "file" with no type); its key, digest, real
 * name, type, size, picture shape and sound go inside the message's seal
 * (`SealedFileRef`), so the server and the storage behind it learn only a
 * blob's size.
 *
 * Reading: a file is fetched and opened with the key its opened message
 * carries, checked against the digest it names, and drawn from an object URL.
 * Opened files are kept for the page within `KEPT_BYTES` (oldest dropped and
 * their URLs revoked first), so scrolling back never fetches one twice and a
 * long room does not grow memory without end.
 */

import type { SealedFileRef } from "./sealed-chat";
import type { MediaShape } from "@/lib/chat/media-shape";
import { writeMediaShape } from "@/lib/chat/media-shape";
import * as fileContent from "@polaris/chat-crypto/file-content";
import { fromText as fromBase64Url, toText as toBase64Url } from "./base64url";

/** How many bytes of opened files this page keeps at once. */
export const KEPT_BYTES = 256 * 1024 * 1024;

/** What one file becomes before its upload: the blob to send, and the reference its message seals. */
export interface FileToSeal {
    readonly blob: Blob;
    /** The reference, once the upload answered the attachment id. */
    readonly ref: (id: string) => SealedFileRef;
}

/** Seal one file for a sealed message; the shape and sound are what the composer measured. */
export async function sealForUpload(
    file: File,
    extra: { readonly shape?: MediaShape | null; readonly durationMs?: number | null; readonly waveform?: string | null; readonly spoiler?: boolean } = {}
): Promise<FileToSeal> {
    const sealed = await fileContent.sealFile(new Uint8Array(await file.arrayBuffer()));
    const key = toBase64Url(sealed.key);
    const sha256 = toBase64Url(sealed.digest);
    sealed.key.fill(0);
    const shape = extra.shape ? writeMediaShape(extra.shape) : null;
    const durationMs = extra.durationMs && extra.durationMs > 0 ? Math.min(Math.round(extra.durationMs), 60 * 60 * 1000) : undefined;
    const waveform = extra.waveform && /^[0-9]{1,64}$/.test(extra.waveform) ? extra.waveform : undefined;
    return {
        blob: new Blob([new Uint8Array(sealed.sealed)], { type: "application/octet-stream" }),
        ref: (id) => ({
            id,
            key,
            sha256,
            name: file.name.slice(0, 200) || "file",
            type: (file.type || "application/octet-stream").slice(0, 200),
            size: file.size,
            ...(shape ? { shape } : {}),
            ...(durationMs ? { durationMs } : {}),
            ...(waveform ? { waveform } : {}),
            ...(extra.spoiler ? { spoiler: true } : {})
        })
    };
}

interface Kept {
    readonly url: string;
    readonly size: number;
}

const kept = new Map<string, Kept>();
const opening = new Map<string, Promise<string | null>>();
/** Files that did not open here: not fetched again on this page. */
const failed = new Set<string>();
let keptBytes = 0;

function keep(id: string, entry: Kept): void {
    kept.set(id, entry);
    keptBytes += entry.size;
    for (const [oldest, one] of kept) {
        if (keptBytes <= KEPT_BYTES || oldest === id) break;
        kept.delete(oldest);
        keptBytes -= one.size;
        URL.revokeObjectURL(one.url);
    }
}

/** Keep the sender's own copy of a file it just sealed, so its row draws without fetching the blob back. */
export function keepLocalFile(id: string, file: Blob): void {
    if (kept.has(id)) return;
    keep(id, { url: URL.createObjectURL(file), size: file.size });
}

/** The object URL of a sealed file this page already opened, or undefined. */
export function openedFileUrl(id: string): string | undefined {
    return kept.get(id)?.url;
}

/**
 * Fetch and open one sealed file; answers its object URL, or null when it did
 * not open (a blob that is not the one its message names never draws).
 */
export function openSealedFile(ref: SealedFileRef): Promise<string | null> {
    const known = kept.get(ref.id);
    if (known) return Promise.resolve(known.url);
    if (failed.has(ref.id)) return Promise.resolve(null);
    const running = opening.get(ref.id);
    if (running) return running;
    const work = (async (): Promise<string | null> => {
        try {
            const response = await fetch(`/api/chat/attachments/${encodeURIComponent(ref.id)}`, { cache: "force-cache" });
            if (!response.ok) throw new Error(`the file answered ${response.status}`);
            const key = fromBase64Url(ref.key);
            try {
                const plain = await fileContent.openFile(key, new Uint8Array(await response.arrayBuffer()), fromBase64Url(ref.sha256));
                const url = URL.createObjectURL(new Blob([new Uint8Array(plain)], { type: ref.type }));
                keep(ref.id, { url, size: plain.length });
                return url;
            } finally {
                key.fill(0);
            }
        } catch (caught) {
            console.warn("polaris: a sealed file could not be opened here:", caught);
            failed.add(ref.id);
            return null;
        } finally {
            opening.delete(ref.id);
        }
    })();
    opening.set(ref.id, work);
    return work;
}
