/**
 * The UPS event log's vocabulary and the rules that raise it, as pure
 * functions over two readings so a test can hold them.
 *
 * Every NUT status flag that rises is one event (`OB` is ONBATT, `TRIM` is
 * TRIM, ...), plus what is not a flag: a finished self-test, the UPS going
 * quiet (COMMBAD, then NOCOMM after a few minutes), answering again
 * (COMMOK), and the shutdown Polaris itself sent. NOPARENT is not here: it is
 * upsmon losing its own parent process, and Polaris runs no upsmon.
 */

import { z } from "zod";

export const UPS_EVENT_KINDS = [
    "ONLINE",
    "ONBATT",
    "LOWBATT",
    "REPLBATT",
    "FSD",
    "CAL",
    "TRIM",
    "BOOST",
    "OFF",
    "OVERLOAD",
    "BYPASS",
    "COMMOK",
    "COMMBAD",
    "NOCOMM",
    "SHUTDOWN",
    "TEST"
] as const;
export type UpsEventKind = (typeof UPS_EVENT_KINDS)[number];
export const upsEventKindSchema = z.enum(UPS_EVENT_KINDS);

/** How loud each kind is, for the log's chips and the notification level. */
export const UPS_EVENT_TONE: Record<UpsEventKind, "danger" | "warning" | "success" | "neutral"> = {
    ONLINE: "success",
    ONBATT: "warning",
    LOWBATT: "danger",
    REPLBATT: "warning",
    FSD: "danger",
    CAL: "neutral",
    TRIM: "neutral",
    BOOST: "neutral",
    OFF: "danger",
    OVERLOAD: "danger",
    BYPASS: "warning",
    COMMOK: "success",
    COMMBAD: "warning",
    NOCOMM: "danger",
    SHUTDOWN: "danger",
    TEST: "neutral"
};

/** The kinds that notify on a UPS nobody has changed the choice of. */
export const DEFAULT_NOTIFY_KINDS: readonly UpsEventKind[] = [
    "ONBATT",
    "LOWBATT",
    "ONLINE",
    "REPLBATT",
    "TEST",
    "COMMBAD",
    "FSD",
    "SHUTDOWN",
    "OVERLOAD"
];

/** The status flag behind each flag-raised kind. */
const FLAG_KIND: Record<string, UpsEventKind> = {
    OB: "ONBATT",
    LB: "LOWBATT",
    RB: "REPLBATT",
    FSD: "FSD",
    CAL: "CAL",
    TRIM: "TRIM",
    BOOST: "BOOST",
    OFF: "OFF",
    OVER: "OVERLOAD",
    BYPASS: "BYPASS"
};

/** What a first reading raises: only what needs somebody now. */
const URGENT: ReadonlySet<UpsEventKind> = new Set(["ONBATT", "LOWBATT", "REPLBATT", "FSD", "OVERLOAD", "OFF"]);

/** `ups.status` as a sorted set of upper-case flags, stored as one string. */
export function normalizeFlags(raw: string | null | undefined): string {
    return [...new Set((raw ?? "").toUpperCase().split(/\s+/).filter((flag) => /^[A-Z]{1,12}$/.test(flag)))]
        .sort()
        .join(" ");
}

/**
 * The events between the flags last seen and now. A flag that rises is its
 * event; OB falling while OL is up is ONLINE. With nothing seen before, only
 * the urgent kinds are raised, never "back online".
 */
export function flagEvents(before: string | null, now: string): UpsEventKind[] {
    const was = new Set((before ?? "").split(" ").filter(Boolean));
    const is = new Set(now.split(" ").filter(Boolean));
    const events: UpsEventKind[] = [];
    for (const [flag, kind] of Object.entries(FLAG_KIND)) {
        if (is.has(flag) && !was.has(flag) && (before !== null || URGENT.has(kind))) events.push(kind);
    }
    if (before !== null && was.has("OB") && !is.has("OB") && is.has("OL")) events.push("ONLINE");
    return events;
}

/** How long a UPS may stay quiet before COMMBAD becomes NOCOMM. */
export const NOCOMM_AFTER_MS = 5 * 60_000;

/**
 * What a pass that could or could not read the UPS adds to the log, and the
 * new `commLostAt`. `nocommLogged` is whether this outage already has its
 * NOCOMM, so a long one is logged once.
 */
export function commEvents(
    commLostAt: Date | null,
    reachable: boolean,
    now: number,
    nocommLogged: boolean
): { events: UpsEventKind[]; commLostAt: Date | null } {
    if (reachable) return { events: commLostAt ? ["COMMOK"] : [], commLostAt: null };
    if (!commLostAt) return { events: ["COMMBAD"], commLostAt: new Date(now) };
    const late = now - commLostAt.getTime() >= NOCOMM_AFTER_MS && !nocommLogged;
    return { events: late ? ["NOCOMM"] : [], commLostAt };
}

/** The notification and automation event each kind is told as. */
export const KIND_NOTICE = {
    ONLINE: "ups.online",
    ONBATT: "ups.onBattery",
    LOWBATT: "ups.lowBattery",
    REPLBATT: "ups.replaceBattery",
    TEST: "ups.test",
    FSD: "ups.shutdown",
    SHUTDOWN: "ups.shutdown",
    OVERLOAD: "ups.overload",
    COMMBAD: "ups.commLost",
    NOCOMM: "ups.commLost",
    COMMOK: "ups.commRestored",
    CAL: "ups.powerIssue",
    TRIM: "ups.powerIssue",
    BOOST: "ups.powerIssue",
    OFF: "ups.powerIssue",
    BYPASS: "ups.powerIssue"
} as const satisfies Record<UpsEventKind, string>;
export type UpsNoticeEvent = (typeof KIND_NOTICE)[UpsEventKind];

/** The event log's filters, as a route reads them from the query. */
export const upsEventQuerySchema = z.object({
    kinds: z
        .string()
        .optional()
        .transform((raw) => (raw ? raw.split(",") : []))
        .pipe(z.array(upsEventKindSchema).max(UPS_EVENT_KINDS.length)),
    state: z.enum(["all", "open", "acknowledged"]).catch("all"),
    days: z.coerce.number().int().min(1).max(365).catch(30),
    before: z.string().datetime().optional().catch(undefined)
});
export type UpsEventQuery = z.infer<typeof upsEventQuerySchema>;
