/**
 * VirusTotal (Public API v3) client. Uploads a file, waits for its analysis to
 * complete, and returns the engine verdict counts plus a link to the full report.
 *
 * Constraints of the free/public API, honored here: uploads through the simple
 * endpoint are capped at 32 MB, and the whole file must be sent (VirusTotal scans
 * bytes, not hashes we hold), so the caller buffers the file first and skips
 * anything larger than the configured limit. The public API is also rate-limited
 * (a few requests per minute), so polling is bounded and spaced out. The API key
 * is a secret and is only ever passed in from the server-side integration store.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { Blob } from "node:buffer";
import { fetch, FormData } from "undici";

/** Largest file the public API will accept through the simple upload endpoint. */
export const VT_MAX_FILE_BYTES = 32 * 1024 * 1024;

const API_BASE = "https://www.virustotal.com/api/v3";
/** Poll the analysis at most this many times before giving up (about 2 minutes). */
const MAX_POLLS = 24;
const POLL_INTERVAL_MS = 5000;

/** Per-engine outcome counts plus the report link, once analysis completes. */
export interface VtVerdict {
    malicious: number;
    suspicious: number;
    harmless: number;
    undetected: number;
    sha256: string | null;
    /** Human-facing VirusTotal report URL, when the file hash is known. */
    permalink: string | null;
    /** Whether analysis finished, or polling timed out first. */
    completed: boolean;
}

interface AnalysisResponse {
    data?: { attributes?: { status?: string; stats?: Record<string, number> } };
    meta?: { file_info?: { sha256?: string } };
}

/** Verify a key works (a cheap authenticated call). Returns null on success. */
export async function verifyVirusTotalKey(apiKey: string): Promise<string | null> {
    try {
        const res = await fetch(`${API_BASE}/metadata`, { headers: { "x-apikey": apiKey } });
        if (res.status === 401 || res.status === 403) return "The API key was rejected by VirusTotal.";
        if (!res.ok) return `VirusTotal returned HTTP ${res.status}.`;
        return null;
    } catch {
        return "Could not reach VirusTotal.";
    }
}

/**
 * Scan a buffered file and wait for the verdict. Throws on transport/auth errors
 * so the caller can record a scan error; returns a verdict (possibly not yet
 * completed) otherwise.
 */
export async function analyzeFile(apiKey: string, fileName: string, bytes: Buffer): Promise<VtVerdict> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), fileName || "upload.bin");

    const upload = await fetch(`${API_BASE}/files`, {
        method: "POST",
        headers: { "x-apikey": apiKey },
        body: form
    });
    if (!upload.ok) {
        throw new Error(`VirusTotal upload failed (HTTP ${upload.status})`);
    }
    const uploadBody = (await upload.json()) as { data?: { id?: string } };
    const analysisId = uploadBody.data?.id;
    if (!analysisId) throw new Error("VirusTotal did not return an analysis id");

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        await sleep(POLL_INTERVAL_MS);
        const res = await fetch(`${API_BASE}/analyses/${encodeURIComponent(analysisId)}`, {
            headers: { "x-apikey": apiKey }
        });
        if (!res.ok) continue;
        const body = (await res.json()) as AnalysisResponse;
        const status = body.data?.attributes?.status;
        if (status !== "completed") continue;

        const stats = body.data?.attributes?.stats ?? {};
        const sha256 = body.meta?.file_info?.sha256 ?? null;
        return {
            malicious: stats.malicious ?? 0,
            suspicious: stats.suspicious ?? 0,
            harmless: stats.harmless ?? 0,
            undetected: stats.undetected ?? 0,
            sha256,
            permalink: sha256 ? `https://www.virustotal.com/gui/file/${sha256}` : null,
            completed: true
        };
    }

    return {
        malicious: 0,
        suspicious: 0,
        harmless: 0,
        undetected: 0,
        sha256: null,
        permalink: null,
        completed: false
    };
}
