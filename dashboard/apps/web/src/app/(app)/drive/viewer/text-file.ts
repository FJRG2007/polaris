/**
 * Reading files as text for the Notepad-style and Markdown editors. The read is
 * capped, so opening a huge file never pulls it all into memory, and content
 * that would not survive a decode/re-encode round-trip is reported as read-only
 * rather than risking a save that corrupts the original.
 */

import { useCallback, useEffect, useState } from "react";

export const TEXT_LIMIT = 500_000;

export interface LoadedText {
    text: string;
    /** Binary content: shown verbatim, never editable. */
    binary: boolean;
    /** The read hit the cap, so the file continues past what is shown. */
    truncated: boolean;
    /** Not clean UTF-8, so re-encoding on save would rewrite bytes. */
    lossy: boolean;
}

/**
 * Read at most `limit` bytes from a response body and report whether more
 * remained. The stream is cancelled once the cap is hit, so opening a huge file
 * as text never pulls the whole thing into memory.
 */
async function readCapped(
    response: Response,
    limit: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const reader = response.body?.getReader();
    if (!reader) {
        const all = new Uint8Array(await response.arrayBuffer());
        return { bytes: all.subarray(0, limit), truncated: all.byteLength > limit };
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
            chunks.push(value);
            received += value.byteLength;
        }
    }
    // Stopped at the cap: one more read tells us whether the file continues.
    let truncated = received > limit;
    if (!truncated && received >= limit) {
        const next = await reader.read();
        truncated = Boolean(!next.done && next.value?.byteLength);
    }
    await reader.cancel().catch(() => undefined);
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes: merged.subarray(0, limit), truncated };
}

/** A NUL byte in the leading bytes is a reliable "this is not text" signal. */
function looksBinary(bytes: Uint8Array): boolean {
    const span = Math.min(bytes.length, 8192);
    for (let index = 0; index < span; index++) {
        if (bytes[index] === 0) return true;
    }
    return false;
}

/** Byte-for-byte equality of two buffers. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let index = 0; index < a.byteLength; index++) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

/**
 * Whether `bytes` is clean UTF-8 that survives a decode/re-encode round-trip.
 * A single-byte encoding (latin-1, windows-1252) has no NUL so it slips past
 * looksBinary, but its undecodable bytes become U+FFFD on decode and would be
 * rewritten on save - corrupting the original. Such files must stay read-only.
 */
function isCleanUtf8(bytes: Uint8Array, decoded: string): boolean {
    return bytesEqual(new TextEncoder().encode(decoded), bytes);
}

/** Load a file as capped text. `setText` adopts saved content as the new baseline. */
export function useTextFile(src: string): {
    file: LoadedText | null;
    error: boolean;
    setText: (text: string) => void;
} {
    const [file, setFile] = useState<LoadedText | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let alive = true;
        setFile(null);
        setError(false);
        void (async () => {
            try {
                const response = await fetch(src);
                if (!response.ok) throw new Error("read failed");
                const { bytes, truncated } = await readCapped(response, TEXT_LIMIT);
                if (!alive) return;
                const text = new TextDecoder().decode(bytes);
                setFile({
                    text,
                    binary: looksBinary(bytes),
                    truncated,
                    // A cut read can slice a multibyte character, so only judge the
                    // encoding when the whole file was read.
                    lossy: !truncated && !isCleanUtf8(bytes, text)
                });
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src]);

    const setText = useCallback((text: string) => {
        setFile((previous) => (previous ? { ...previous, text } : previous));
    }, []);

    return { file, error, setText };
}

/** Why a loaded file cannot be edited, or null when it can. */
export function readOnlyReason(file: LoadedText): string | null {
    if (file.binary) return "Binary file";
    if (file.truncated) return "Preview only (large file)";
    if (file.lossy) return "Preview only (unsupported encoding)";
    return null;
}
