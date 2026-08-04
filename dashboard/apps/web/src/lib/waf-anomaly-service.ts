/**
 * Running the route-abuse detector against real traffic, and deciding what to do
 * with what it finds.
 *
 * Findings are recomputed from the edge log rather than stored. They are a statement
 * about a window that is always moving, so a stored one is wrong the moment it is
 * written, and the log already holds everything needed to produce them again. The
 * only thing that persists is a ban, which is a decision rather than an observation.
 */

import { readFile } from "node:fs/promises";
import { parseHttpLogs } from "@polaris/deploy";
import { wafTrustedAddresses } from "@/lib/waf-ban-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { recordWafBan, publishWafIntel } from "@/lib/waf-intel-service";
import { detectWafAnomalies, type WafAnomaly, type WafAnomalyOptions } from "@polaris/core";

const ACCESS_LOG_FILE = process.env.POLARIS_TRAEFIK_ACCESSLOG ?? "/traefik-log/access.log";
const SETTINGS_KEY = "waf.anomalies";
const TAIL_BYTES = 4 * 1024 * 1024;

/** The window the detector judges. Long enough that a baseline means something,
 *  short enough that a burst is still visible in it rather than averaged away. */
const WINDOW_MS = 10 * 60 * 1000;

export interface WafAnomalySettings extends Required<WafAnomalyOptions> {
    readonly enabled: boolean;
    /** Whether a high-severity finding bans the address on its own. Off by default:
     *  seeing what it would have caught, before it catches it, is how an operator
     *  learns to trust it. */
    readonly autoBlock: boolean;
    /** How long an automatic block lasts, in seconds. */
    readonly banTimeSec: number;
}

const DEFAULTS: WafAnomalySettings = {
    enabled: true,
    autoBlock: false,
    banTimeSec: 3600,
    minHits: 20,
    overBaseline: 8,
    assetMax: 60,
    variantMax: 30
};

export async function getWafAnomalySettings(): Promise<WafAnomalySettings> {
    const raw = await getSetting(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    try {
        const saved = JSON.parse(raw) as Partial<WafAnomalySettings>;
        return {
            enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
            autoBlock: typeof saved.autoBlock === "boolean" ? saved.autoBlock : DEFAULTS.autoBlock,
            banTimeSec: clamp(saved.banTimeSec, 60, 30 * 24 * 3600, DEFAULTS.banTimeSec),
            minHits: clamp(saved.minHits, 5, 100000, DEFAULTS.minHits),
            overBaseline: clamp(saved.overBaseline, 2, 1000, DEFAULTS.overBaseline),
            assetMax: clamp(saved.assetMax, 5, 100000, DEFAULTS.assetMax),
            variantMax: clamp(saved.variantMax, 5, 100000, DEFAULTS.variantMax)
        };
    } catch {
        return DEFAULTS;
    }
}

export async function setWafAnomalySettings(settings: WafAnomalySettings): Promise<void> {
    await setSetting(SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * What the detector currently sees. Empty when it is switched off or there is no edge
 * log to read, which the panel reports as such rather than as "all clear".
 *
 * The trusted addresses are passed through rather than filtered out afterwards: an
 * operator's own address is the heaviest legitimate user of their own instance, and
 * against a route's ordinary visitor that reads as a flood. Reporting it and then
 * hiding the finding would still ban it when automatic blocking is on.
 */
export async function currentWafAnomalies(now = Date.now()): Promise<WafAnomaly[]> {
    const settings = await getWafAnomalySettings();
    if (!settings.enabled) return [];
    const raw = await readLogTail();
    if (!raw) return [];
    const exempt = await wafTrustedAddresses();
    return detectWafAnomalies(parseHttpLogs(raw), now - WINDOW_MS, now, { ...settings, exempt });
}

/**
 * One detection pass for the background loop. Bans the addresses behind high-severity
 * findings when the operator has asked for that, and reports how many it saw either
 * way so the tick can say something useful.
 */
export async function runWafAnomalies(now = Date.now()): Promise<{ found: number; banned: number }> {
    const settings = await getWafAnomalySettings();
    if (!settings.enabled) return { found: 0, banned: 0 };
    const anomalies = await currentWafAnomalies(now);
    if (!settings.autoBlock) return { found: anomalies.length, banned: 0 };

    // One ban per address however many findings it produced - the address is what is
    // being blocked, and three notes about the same one is noise.
    const worst = new Map<string, WafAnomaly>();
    for (const anomaly of anomalies) {
        if (anomaly.severity !== "high") continue;
        if (!worst.has(anomaly.ip)) worst.set(anomaly.ip, anomaly);
    }
    for (const anomaly of worst.values()) {
        await recordWafBan({
            ip: anomaly.ip,
            reason: "ban",
            source: `anomaly:${anomaly.kind}`,
            note: `${anomaly.route}: ${anomaly.detail}`,
            until: new Date(now + settings.banTimeSec * 1000)
        });
    }
    if (worst.size > 0) await publishWafIntel();
    return { found: anomalies.length, banned: worst.size };
}

async function readLogTail(): Promise<string> {
    let raw: string;
    try {
        raw = await readFile(ACCESS_LOG_FILE, "utf8");
    } catch {
        return "";
    }
    if (raw.length <= TAIL_BYTES) return raw;
    const cut = raw.slice(raw.length - TAIL_BYTES);
    return cut.slice(cut.indexOf("\n") + 1);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}
