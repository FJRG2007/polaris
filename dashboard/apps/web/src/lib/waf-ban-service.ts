/**
 * The jail runner: reading the edge's access log, deciding who has earned a ban, and
 * handing the verdicts to the intel service to publish.
 *
 * This is the half of the firewall that a forwardAuth guard structurally cannot do.
 * The guard is called before the response exists, so it never sees the 404 it would
 * have to count; the access log Traefik already writes has every one. So the counting
 * happens here, on a timer, off the request path entirely - which is also why a jail
 * can afford to look at five minutes of history without costing a request anything.
 *
 * The decisions themselves are pure and live in @polaris/core (detectWafBans); this
 * module is the I/O around them: read the log, load the settings, persist the bans,
 * republish.
 */

import { readFile } from "node:fs/promises";
import { parseHttpLogs } from "@polaris/deploy";
import { getSetting, setSetting } from "@/lib/setting-store";
import { DEFAULT_WAF_JAILS, detectWafBans, type WafJail } from "@polaris/core";
import {
    checkReputation,
    priorBanCounts,
    publishWafIntel,
    recordWafBan,
    wafTrustedAddresses
} from "@/lib/waf-intel-service";

/** The edge's per-request access log, the same file the HTTP Logs view reads. */
const ACCESS_LOG_FILE = process.env.POLARIS_TRAEFIK_ACCESSLOG ?? "/traefik-log/access.log";

const JAILS_KEY = "waf.jails";

/**
 * How much of the log tail to read. The longest default window is ten minutes; this
 * is sized to comfortably cover it on a busy instance without loading a log that has
 * been growing for months into memory.
 */
const TAIL_BYTES = 4 * 1024 * 1024;

/** The configured jails, falling back to the defaults for anything unsaved. Stored
 *  settings are merged onto the shipped list rather than replacing it, so a jail
 *  added in a later release appears with its default instead of vanishing. */
export async function getWafJails(): Promise<WafJail[]> {
    const raw = await getSetting(JAILS_KEY);
    const saved = parseJson<Partial<WafJail>[]>(raw) ?? [];
    const byId = new Map(saved.filter((jail) => typeof jail?.id === "string").map((jail) => [jail.id, jail]));
    return DEFAULT_WAF_JAILS.map((jail) => {
        const override = byId.get(jail.id);
        if (!override) return jail;
        return {
            ...jail,
            enabled: typeof override.enabled === "boolean" ? override.enabled : jail.enabled,
            maxRetry: clamp(override.maxRetry, 1, 1000, jail.maxRetry),
            findTimeSec: clamp(override.findTimeSec, 10, 86400, jail.findTimeSec),
            banTimeSec: clamp(override.banTimeSec, 60, 30 * 24 * 3600, jail.banTimeSec)
        };
    });
}

/** The fields an operator owns. The label and the description belong to the release,
 *  so they are neither stored nor accepted back. */
export type WafJailSettings = Pick<WafJail, "id" | "enabled" | "maxRetry" | "findTimeSec" | "banTimeSec">;

/** Save the jail settings. */
export async function setWafJails(jails: readonly WafJailSettings[]): Promise<void> {
    const stored = jails.map((jail) => ({
        id: jail.id,
        enabled: jail.enabled,
        maxRetry: jail.maxRetry,
        findTimeSec: jail.findTimeSec,
        banTimeSec: jail.banTimeSec
    }));
    await setSetting(JAILS_KEY, JSON.stringify(stored));
}

/**
 * One pass: read the log tail, apply the jails, persist any new bans, ask the
 * reputation provider about addresses it has not seen, and republish the snapshot.
 *
 * Returns what it did, so the caller can log something useful and the tests can
 * assert on it. Never throws: this runs on a timer and a bad pass must not stop the
 * next one.
 */
export async function runWafJails(now = Date.now()): Promise<{ scanned: number; banned: number }> {
    try {
        const [jails, ignore] = await Promise.all([getWafJails(), wafTrustedAddresses()]);
        if (!jails.some((jail) => jail.enabled)) return { scanned: 0, banned: 0 };

        const entries = parseHttpLogs(await readLogTail());
        if (entries.length === 0) return { scanned: 0, banned: 0 };

        const seen = entries.map((entry) => entry.ip).filter((ip) => ip && ip !== "-");
        const verdicts = detectWafBans({
            entries,
            jails,
            ignore,
            priorBans: await priorBanCounts([...new Set(seen)]),
            now
        });

        for (const verdict of verdicts) {
            await recordWafBan({
                ip: verdict.ip,
                reason: "ban",
                source: verdict.jail,
                note: verdict.note,
                // Null travels through as null: a credential probe is held until an
                // operator lifts it, and the intel snapshot already understands that.
                until: verdict.until === null ? null : new Date(verdict.until)
            });
        }

        // Reputation is asked about the same traffic, in the same pass, so an address
        // that is already known bad elsewhere is blocked before it earns a ban here.
        await checkReputation([...new Set(seen)].filter((ip) => !ignore.includes(ip)));
        await publishWafIntel();
        return { scanned: entries.length, banned: verdicts.length };
    } catch (caught) {
        console.error("polaris: the firewall jail pass failed:", caught instanceof Error ? caught.message : caught);
        return { scanned: 0, banned: 0 };
    }
}

/** The last few megabytes of the access log. Reading the whole file would grow
 *  without bound with the log; the window a jail looks at never does. */
async function readLogTail(): Promise<string> {
    let raw: string;
    try {
        raw = await readFile(ACCESS_LOG_FILE, "utf8");
    } catch {
        return "";
    }
    if (raw.length <= TAIL_BYTES) return raw;
    const cut = raw.slice(raw.length - TAIL_BYTES);
    // Drop the partial first line so the parser is never handed half a JSON object.
    return cut.slice(cut.indexOf("\n") + 1);
}

function parseJson<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}
