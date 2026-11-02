/**
 * A thin VirusTotal API v3 client for file reputation. The cheap path is a hash
 * lookup: most files VirusTotal has ever seen are known by their SHA-256, so no
 * upload is needed. Only an unknown file within the Public API's 32 MB limit is
 * uploaded and its analysis polled to completion. Everything is bounded by a
 * timeout so a scan can never hang an upload indefinitely; on timeout or API
 * error the caller treats the verdict as "unknown" and fails open (with an alert)
 * rather than rejecting legitimate files because the scanner was unavailable.
 */

import { readerWords } from "@/lib/i18n/reader-words";
import { ProviderPaused, whileServing } from "@/lib/integrations/provider-pause";
import { takeLookup } from "@/lib/reputation-budget";

const BASE = "https://www.virustotal.com/api/v3";
const PROVIDER = "virustotal";
const NAME = "VirusTotal";

/** What a file scan may use of the key's budget. Anybody with a drop point's link can
 *  start one, so the rest stays for the mail filter and chat. */
export const SCAN_SHARE = 0.75;

/** Polling an analysis, spaced to fit the free key's four requests a minute alongside
 *  the lookup and the upload that came before. */
const POLLS = 3;
const POLL_EVERY_MS = 20_000;

/** A failed answer the gate can read the status of. Every lookup below reports it
 *  to its caller as an `error` verdict, as it always did. */
function failed(detail: string, status: number): Error {
    return Object.assign(new Error(detail), { status });
}

/** The verdict for a request that was not answered or never sent. */
function noOpinion(caught: unknown, fallback: string): VtVerdict {
    if (caught instanceof ProviderPaused && caught.reason === "budget") {
        return { kind: "error", malicious: 0, suspicious: 0, detail: "VirusTotal used up today's requests" };
    }
    const status = (caught as { status?: unknown } | null)?.status;
    const detail = typeof status === "number" && caught instanceof Error ? caught.message : fallback;
    return { kind: "error", malicious: 0, suspicious: 0, detail };
}
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
    const kind: VtVerdictKind =
        malicious > 0 ? "malicious" : suspicious > 0 ? "suspicious" : "clean";
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
        if (response.status === 401 || response.status === 403)
            return { ok: false, error: (await readerWords("api"))("refusals.virusTotal.invalidKey") };
        if (response.status >= 500)
            return { ok: false, error: (await readerWords("api"))("refusals.virusTotal.unavailable", { status: response.status }) };
        return { ok: true };
    } catch (caught) {
        return {
            ok: false,
            error: caught instanceof Error ? caught.message : (await readerWords("api"))("refusals.virusTotal.unreachable")
        };
    }
}

/**
 * Look up a file by hash. Returns a verdict, or null when VirusTotal has never
 * seen the file (HTTP 404) so the caller can decide whether to upload it.
 */
export async function lookupBySha256(apiKey: string, sha256: string): Promise<VtVerdict | null> {
    return whileServing(PROVIDER, NAME, async () => {
        const response = await fetch(`${BASE}/files/${sha256}`, {
            headers: { "x-apikey": apiKey },
            signal: AbortSignal.timeout(15000)
        });
        if (response.status === 404) return null;
        if (!response.ok) {
            throw failed(`VirusTotal responded ${response.status}`, response.status);
        }
        const body = (await response.json()) as {
            data?: { attributes?: { last_analysis_stats?: AnalysisStats } };
        };
        const stats = body.data?.attributes?.last_analysis_stats ?? {};
        return verdictFromStats(stats, fileLink(sha256));
    }).catch((caught: unknown) => noOpinion(caught, "VirusTotal was unreachable"));
}

/**
 * Upload an unknown file (<= 32 MB) and poll its analysis to completion. Returns
 * "unknown" if the analysis does not finish within the budget, so the caller can
 * fail open. The SHA-256 is only used to build the report permalink.
 */
export function uploadAndScan(
    apiKey: string,
    bytes: Uint8Array,
    sha256: string
): Promise<VtVerdict> {
    return submitAndPoll(apiKey, bytes, sha256).catch((caught: unknown) =>
        noOpinion(caught, "VirusTotal was unreachable")
    );
}

async function submitAndPoll(
    apiKey: string,
    bytes: Uint8Array,
    sha256: string
): Promise<VtVerdict> {
    const analysisId = await whileServing(PROVIDER, NAME, async () => {
        const form = new FormData();
        form.append("file", new Blob([bytes]), "upload.bin");
        const submit = await fetch(`${BASE}/files`, {
            method: "POST",
            headers: { "x-apikey": apiKey },
            body: form,
            signal: AbortSignal.timeout(60000)
        });
        if (!submit.ok) throw failed(`VirusTotal upload failed (${submit.status})`, submit.status);
        const body = (await submit.json()) as { data?: { id?: string } };
        return body.data?.id;
    });
    if (!analysisId)
        return { kind: "error", malicious: 0, suspicious: 0, detail: "No analysis id returned" };

    for (let attempt = 0; attempt < POLLS; attempt++) {
        await sleep(POLL_EVERY_MS);
        if (!takeLookup(PROVIDER, SCAN_SHARE)) continue;
        const attributes = await whileServing(PROVIDER, NAME, async () => {
            const poll = await fetch(`${BASE}/analyses/${analysisId}`, {
                headers: { "x-apikey": apiKey },
                signal: AbortSignal.timeout(15000)
            });
            if (!poll.ok) throw failed(`VirusTotal answered ${poll.status}`, poll.status);
            const body = (await poll.json()) as {
                data?: { attributes?: { status?: string; stats?: AnalysisStats } };
            };
            return body.data?.attributes;
        });
        if (attributes?.status === "completed") {
            return verdictFromStats(attributes.stats ?? {}, fileLink(sha256));
        }
    }
    return {
        kind: "unknown",
        malicious: 0,
        suspicious: 0,
        detail: "Scan did not complete in time",
        permalink: fileLink(sha256)
    };
}

/** Where a domain's report is read by a person. */
function domainLink(domain: string): string {
    return `https://www.virustotal.com/gui/domain/${encodeURIComponent(domain)}`;
}

/**
 * What the engines say about a domain.
 *
 * The same shape as the file lookup and the same tallies - a domain report
 * carries `last_analysis_stats` exactly as a file report does - so one verdict
 * type covers both and nothing downstream has to know which was asked.
 *
 * A domain VirusTotal has never seen answers 404, and that is `unknown` rather
 * than an error: most domains are not in there, and a mail filter must not treat
 * "not famous" as "dangerous". Everything else that goes wrong is `error`, which
 * the caller is expected to treat as no opinion at all.
 */
export async function lookupDomain(apiKey: string, domain: string): Promise<VtVerdict> {
    const cleaned = domain.trim().toLowerCase();
    if (!cleaned || !cleaned.includes(".")) {
        return { kind: "unknown", malicious: 0, suspicious: 0 };
    }
    return whileServing(PROVIDER, NAME, async () => {
        const response = await fetch(`${BASE}/domains/${encodeURIComponent(cleaned)}`, {
            headers: { "x-apikey": apiKey },
            signal: AbortSignal.timeout(15000)
        });
        if (response.status === 404) {
            return {
                kind: "unknown" as const,
                malicious: 0,
                suspicious: 0,
                permalink: domainLink(cleaned)
            };
        }
        if (!response.ok) throw failed(`VirusTotal answered ${response.status}`, response.status);
        const body = (await response.json()) as {
            data?: { attributes?: { last_analysis_stats?: AnalysisStats } };
        };
        return verdictFromStats(
            body.data?.attributes?.last_analysis_stats ?? {},
            domainLink(cleaned)
        );
    }).catch((caught: unknown) => noOpinion(caught, "VirusTotal was unreachable"));
}
