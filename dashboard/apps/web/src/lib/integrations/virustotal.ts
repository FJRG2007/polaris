/**
 * A thin VirusTotal API v3 client for file reputation. The cheap path is a hash
 * lookup: most files VirusTotal has ever seen are known by their SHA-256, so no
 * upload is needed. Only an unknown file within the Public API's 32 MB limit is
 * uploaded and its analysis polled to completion. Everything is bounded by a
 * timeout so a scan can never hang an upload indefinitely; on timeout or API
 * error the caller treats the verdict as "unknown" and fails open (with an alert)
 * rather than rejecting legitimate files because the scanner was unavailable.
 */

const BASE = "https://www.virustotal.com/api/v3";
/** Public API file-upload ceiling. Larger files can only be looked up by hash. */
export const VT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export type VtVerdictKind = "clean" | "suspicious" | "malicious" | "unknown" | "error";

export interface VtVerdict {
    kind: VtVerdictKind;
    malicious: number;
    suspicious: number;
    permalink?: string;
    detail?: string;
}

interface AnalysisStats {
    malicious?: number;
    suspicious?: number;
}

/** Map VirusTotal's engine tallies to a single verdict. */
function verdictFromStats(stats: AnalysisStats, permalink?: string): VtVerdict {
    const malicious = Number(stats.malicious ?? 0);
    const suspicious = Number(stats.suspicious ?? 0);
    const kind: VtVerdictKind = malicious > 0 ? "malicious" : suspicious > 0 ? "suspicious" : "clean";
    return { kind, malicious, suspicious, permalink };
}

function fileLink(sha256: string): string {
    return `https://www.virustotal.com/gui/file/${sha256}`;
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SHA-256 of the empty file - always known to VirusTotal, so a lookup checks a key. */
const EMPTY_FILE_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Validate an API key with one cheap lookup. A 401/403 means the key is bad; any
 * other reachable response (200, 404, or a rate-limit 429) means it authenticated.
 */
export async function verifyKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const response = await fetch(`${BASE}/files/${EMPTY_FILE_SHA256}`, {
            headers: { "x-apikey": apiKey },
            signal: AbortSignal.timeout(15000)
        });
        if (response.status === 401 || response.status === 403) return { ok: false, error: "Invalid API key" };
        if (response.status >= 500) return { ok: false, error: `VirusTotal is unavailable (${response.status})` };
        return { ok: true };
    } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : "Could not reach VirusTotal" };
    }
}

/**
 * Look up a file by hash. Returns a verdict, or null when VirusTotal has never
 * seen the file (HTTP 404) so the caller can decide whether to upload it.
 */
export async function lookupBySha256(apiKey: string, sha256: string): Promise<VtVerdict | null> {
    const response = await fetch(`${BASE}/files/${sha256}`, {
        headers: { "x-apikey": apiKey },
        signal: AbortSignal.timeout(15000)
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        return { kind: "error", malicious: 0, suspicious: 0, detail: `VirusTotal responded ${response.status}` };
    }
    const body = (await response.json()) as { data?: { attributes?: { last_analysis_stats?: AnalysisStats } } };
    const stats = body.data?.attributes?.last_analysis_stats ?? {};
    return verdictFromStats(stats, fileLink(sha256));
}

/**
 * Upload an unknown file (<= 32 MB) and poll its analysis to completion. Returns
 * "unknown" if the analysis does not finish within the budget, so the caller can
 * fail open. The SHA-256 is only used to build the report permalink.
 */
export async function uploadAndScan(apiKey: string, bytes: Uint8Array, sha256: string): Promise<VtVerdict> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), "upload.bin");
    const submit = await fetch(`${BASE}/files`, {
        method: "POST",
        headers: { "x-apikey": apiKey },
        body: form,
        signal: AbortSignal.timeout(60000)
    });
    if (!submit.ok) {
        return { kind: "error", malicious: 0, suspicious: 0, detail: `VirusTotal upload failed (${submit.status})` };
    }
    const submitBody = (await submit.json()) as { data?: { id?: string } };
    const analysisId = submitBody.data?.id;
    if (!analysisId) return { kind: "error", malicious: 0, suspicious: 0, detail: "No analysis id returned" };

    // Poll the analysis. Public API is rate-limited, so keep the cadence modest.
    for (let attempt = 0; attempt < 15; attempt++) {
        await sleep(attempt === 0 ? 3000 : 4000);
        const poll = await fetch(`${BASE}/analyses/${analysisId}`, {
            headers: { "x-apikey": apiKey },
            signal: AbortSignal.timeout(15000)
        });
        if (!poll.ok) continue;
        const pollBody = (await poll.json()) as {
            data?: { attributes?: { status?: string; stats?: AnalysisStats } };
        };
        const attributes = pollBody.data?.attributes;
        if (attributes?.status === "completed") {
            return verdictFromStats(attributes.stats ?? {}, fileLink(sha256));
        }
    }
    return { kind: "unknown", malicious: 0, suspicious: 0, detail: "Scan did not complete in time", permalink: fileLink(sha256) };
}
