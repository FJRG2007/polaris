/**
 * What a UPS has recorded: its event log, its energy rollups, the commands
 * and changes made on it, CSV exports, the multi-UPS overview and scheduled
 * reports. Reads are bounded by a range and a row cap and served from the
 * (upsId, ts) indexes; rollups are summed in the database, never in code.
 */

import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import * as upsEvents from "./ups-events";
import * as upsSettings from "./ups-settings";
import { requireDriveDriver } from "@/lib/drive-authz";
import { ensurePersonalDrive } from "@/lib/personal-drive";

const DAY_MS = 86_400_000;
/** Most rows one page of the event log holds. */
export const EVENT_PAGE = 100;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface UpsEventView {
    id: string;
    ts: string;
    kind: upsEvents.UpsEventKind;
    detail: string | null;
    acknowledgedAt: string | null;
}

export async function recordEvent(
    upsId: string,
    kind: upsEvents.UpsEventKind,
    at: Date,
    detail?: string | null
) {
    await prisma.upsEvent
        .create({ data: { upsId, kind, ts: at, detail: detail ? detail.slice(0, 200) : null } })
        .catch((error: unknown) =>
            console.error("polaris: a UPS event could not be logged:", error)
        );
}

export async function listEvents(
    upsId: string,
    query: upsEvents.UpsEventQuery,
    now = Date.now()
): Promise<{ events: UpsEventView[]; more: boolean; open: number }> {
    const where = {
        upsId,
        ts: {
            gte: new Date(now - query.days * DAY_MS),
            ...(query.before ? { lt: new Date(query.before) } : {})
        },
        ...(query.kinds.length > 0 ? { kind: { in: query.kinds } } : {}),
        ...(query.state === "open"
            ? { acknowledgedAt: null }
            : query.state === "acknowledged"
              ? { acknowledgedAt: { not: null } }
              : {})
    };
    const [rows, open] = await Promise.all([
        prisma.upsEvent.findMany({
            where,
            orderBy: { ts: "desc" },
            take: EVENT_PAGE + 1,
            select: { id: true, ts: true, kind: true, detail: true, acknowledgedAt: true }
        }),
        prisma.upsEvent.count({ where: { upsId, acknowledgedAt: null } })
    ]);
    return {
        events: rows.slice(0, EVENT_PAGE).map((row) => ({
            id: row.id,
            ts: row.ts.toISOString(),
            kind: row.kind as upsEvents.UpsEventKind,
            detail: row.detail,
            acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null
        })),
        more: rows.length > EVENT_PAGE,
        open
    };
}

/** Mark events seen: the ids given, or every open one of the UPS. */
export async function acknowledgeEvents(
    upsId: string,
    ids: string[] | "all",
    userId: string
): Promise<number> {
    const result = await prisma.upsEvent.updateMany({
        where: { upsId, acknowledgedAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
        data: { acknowledgedAt: new Date(), acknowledgedById: userId }
    });
    return result.count;
}

/** The self-tests a UPS reported, newest first. */
export async function testHistory(upsId: string): Promise<{ ts: string; result: string | null }[]> {
    const rows = await prisma.upsEvent.findMany({
        where: { upsId, kind: "TEST" },
        orderBy: { ts: "desc" },
        take: 50,
        select: { ts: true, detail: true }
    });
    return rows.map((row) => ({ ts: row.ts.toISOString(), result: row.detail }));
}

// ---------------------------------------------------------------------------
// Commands and changes
// ---------------------------------------------------------------------------

export interface UpsActionView {
    id: string;
    ts: string;
    kind: "command" | "variable";
    name: string;
    value: string | null;
    outcome: string;
    actor: string | null;
}

export async function logAction(input: {
    upsId: string;
    actorId: string | null;
    kind: "command" | "variable";
    name: string;
    value?: string | null;
    outcome: string;
}) {
    await prisma.upsAction
        .create({
            data: {
                upsId: input.upsId,
                actorId: input.actorId,
                kind: input.kind,
                name: input.name,
                value: input.value ?? null,
                outcome: input.outcome
            }
        })
        .catch((error: unknown) =>
            console.error("polaris: a UPS action could not be logged:", error)
        );
}

export async function listActions(
    upsId: string,
    kind?: "command" | "variable"
): Promise<UpsActionView[]> {
    const rows = await prisma.upsAction.findMany({
        where: { upsId, ...(kind ? { kind } : {}) },
        orderBy: { ts: "desc" },
        take: 100
    });
    const actorIds = [
        ...new Set(rows.map((row) => row.actorId).filter((id): id is string => id !== null))
    ];
    const actors = actorIds.length
        ? await prisma.user.findMany({
              where: { id: { in: actorIds } },
              select: { id: true, name: true }
          })
        : [];
    const names = new Map(actors.map((actor) => [actor.id, actor.name]));
    return rows.map((row) => ({
        id: row.id,
        ts: row.ts.toISOString(),
        kind: row.kind as UpsActionView["kind"],
        name: row.name,
        value: row.value,
        outcome: row.outcome,
        actor: row.actorId ? (names.get(row.actorId) ?? null) : null
    }));
}

// ---------------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------------

export interface EnergyBucket {
    ts: string;
    kwh: number;
    cost: number;
    currency: string;
}

/** Most buckets one UPS adds to a rollup; above any span the query schema allows. */
const ROLLUP_ROWS_PER_UPS = 20_000;

/** Energy in hour, day or month buckets of the reader's own time zone. */
export async function energyRollup(upsIds: string[], query: upsSettings.EnergyQuery) {
    if (upsIds.length === 0) return [];
    const rows = await prisma.$queryRaw<
        { upsId: string; bucket: Date; wh: number; cost: number; currency: string }[]
    >`
        SELECT "upsId",
               (date_trunc(${query.unit}, "hour" AT TIME ZONE 'UTC' AT TIME ZONE ${query.tz}) AT TIME ZONE ${query.tz}) AS bucket,
               SUM("wh")::float8 AS wh,
               SUM("cost")::float8 AS cost,
               "currency"
        FROM "UpsEnergyHour"
        WHERE "upsId" = ANY(${upsIds}::uuid[]) AND "hour" >= ${query.from} AND "hour" < ${query.to}
        GROUP BY "upsId", bucket, "currency"
        ORDER BY bucket ASC
        LIMIT ${ROLLUP_ROWS_PER_UPS * upsIds.length}`;
    return rows.map((row) => ({
        upsId: row.upsId,
        ts: row.bucket.toISOString(),
        kwh: row.wh / 1000,
        cost: row.cost,
        currency: row.currency
    }));
}

/** Totals per currency over a span: what one UPS (or all) used and cost. */
export function energyTotals(buckets: readonly { kwh: number; cost: number; currency: string }[]) {
    const kwh = buckets.reduce((sum, one) => sum + one.kwh, 0);
    const costs = new Map<string, number>();
    for (const one of buckets) costs.set(one.currency, (costs.get(one.currency) ?? 0) + one.cost);
    return { kwh, costs: [...costs].map(([currency, cost]) => ({ currency, cost })) };
}

// ---------------------------------------------------------------------------
// Multi-UPS overview
// ---------------------------------------------------------------------------

export interface UpsAnalyticsRow {
    upsId: string;
    name: string;
    kwh: number;
    costs: { currency: string; cost: number }[];
    events: number;
    outages: number;
    avgLoad: number | null;
    maxLoad: number | null;
}

export async function analytics(days: number, tz: string, now = Date.now()) {
    const from = new Date(now - days * DAY_MS);
    const to = new Date(now);
    const rows = await prisma.ups.findMany({
        orderBy: { createdAt: "asc" },
        take: 200,
        select: { id: true, name: true }
    });
    const ids = rows.map((row) => row.id);
    if (ids.length === 0)
        return { rows: [], daily: [] as Awaited<ReturnType<typeof energyRollup>> };
    const [daily, events, outages, loads] = await Promise.all([
        energyRollup(ids, { unit: "day", from, to, tz }),
        prisma.upsEvent.groupBy({
            by: ["upsId"],
            where: { upsId: { in: ids }, ts: { gte: from } },
            _count: true
        }),
        prisma.upsEvent.groupBy({
            by: ["upsId"],
            where: { upsId: { in: ids }, ts: { gte: from }, kind: "ONBATT" },
            _count: true
        }),
        prisma.upsSample.groupBy({
            by: ["upsId"],
            where: { upsId: { in: ids }, ts: { gte: from } },
            _avg: { load: true },
            _max: { load: true }
        })
    ]);
    const count = (list: { upsId: string; _count: number }[], id: string) =>
        list.find((one) => one.upsId === id)?._count ?? 0;
    return {
        rows: rows.map((row): UpsAnalyticsRow => {
            const totals = energyTotals(daily.filter((one) => one.upsId === row.id));
            const load = loads.find((one) => one.upsId === row.id);
            return {
                upsId: row.id,
                name: row.name,
                kwh: totals.kwh,
                costs: totals.costs,
                events: count(events, row.id),
                outages: count(outages, row.id),
                avgLoad: load?._avg.load ?? null,
                maxLoad: load?._max.load ?? null
            };
        }),
        daily
    };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/** Rows one export query reads at a time. */
const EXPORT_PAGE = 5_000;

/** One UPS's records over the last `days` as CSV, read and yielded a page at a time. */
export async function* exportCsv(
    upsId: string,
    what: upsSettings.ExportKind,
    days: number,
    now = Date.now()
) {
    const since = new Date(now - days * DAY_MS);
    const take = EXPORT_PAGE;
    const line = (row: readonly unknown[]) => `${row.map(upsSettings.csvCell).join(",")}\r\n`;
    if (what === "samples") {
        yield line([
            "time",
            "charge_pct",
            "runtime_s",
            "load_pct",
            "power_w",
            "input_v",
            "input_hz",
            "output_v",
            "battery_v"
        ]);
        for (let after = since, first = true; ; first = false) {
            const rows = await prisma.upsSample.findMany({
                where: { upsId, ts: first ? { gte: after } : { gt: after } },
                orderBy: { ts: "asc" },
                take
            });
            if (rows.length > 0) {
                yield rows
                    .map((r) =>
                        line([
                            r.ts,
                            r.charge,
                            r.runtimeS,
                            r.load,
                            r.powerW,
                            r.inputV,
                            r.inputHz,
                            r.outputV,
                            r.batteryV
                        ])
                    )
                    .join("");
            }
            if (rows.length < take) return;
            after = rows[rows.length - 1]!.ts;
        }
    }
    if (what === "energy") {
        yield line(["hour", "kwh", "cost", "currency"]);
        for (let after = since, first = true; ; first = false) {
            const rows = await prisma.upsEnergyHour.findMany({
                where: { upsId, hour: first ? { gte: after } : { gt: after } },
                orderBy: { hour: "asc" },
                take
            });
            if (rows.length > 0) {
                yield rows
                    .map((r) =>
                        line([r.hour, (r.wh / 1000).toFixed(4), r.cost.toFixed(4), r.currency])
                    )
                    .join("");
            }
            if (rows.length < take) return;
            after = rows[rows.length - 1]!.hour;
        }
    }
    if (what === "events") {
        yield line(["time", "event", "detail", "acknowledged_at"]);
        for (let cursor: string | undefined; ; ) {
            const rows = await prisma.upsEvent.findMany({
                where: { upsId, ts: { gte: since } },
                orderBy: [{ ts: "asc" }, { id: "asc" }],
                take,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
            });
            if (rows.length > 0)
                yield rows.map((r) => line([r.ts, r.kind, r.detail, r.acknowledgedAt])).join("");
            if (rows.length < take) return;
            cursor = rows[rows.length - 1]!.id;
        }
    }
    yield line(["time", "kind", "name", "value", "outcome"]);
    for (let cursor: string | undefined; ; ) {
        const rows = await prisma.upsAction.findMany({
            where: { upsId, ts: { gte: since } },
            orderBy: [{ ts: "asc" }, { id: "asc" }],
            take,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        if (rows.length > 0)
            yield rows.map((r) => line([r.ts, r.kind, r.name, r.value, r.outcome])).join("");
        if (rows.length < take) return;
        cursor = rows[rows.length - 1]!.id;
    }
}

/** A file name safe on every storage: the UPS name's plain letters only. */
export function fileStem(name: string): string {
    return (
        name
            .normalize("NFKD")
            .replace(/[^\w.-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "ups"
    );
}

export const DRIVE_FOLDER = "UPS";

async function* utf8Chunks(content: string | AsyncIterable<string>) {
    if (typeof content === "string") {
        yield Buffer.from(content, "utf8");
        return;
    }
    for await (const chunk of content) yield Buffer.from(chunk, "utf8");
}

/** Write a text file into this person's own drive, under `UPS/`. */
export async function saveToDrive(
    userId: string,
    fileName: string,
    content: string | AsyncIterable<string>
): Promise<string> {
    const drive = await ensurePersonalDrive(userId);
    const driver = await requireDriveDriver(userId, drive.id, DRIVE_FOLDER, "write");
    try {
        await driver.mkdir(DRIVE_FOLDER).catch(() => undefined);
        const path = `${DRIVE_FOLDER}/${fileName}`;
        const body = Readable.toWeb(
            Readable.from(utf8Chunks(content))
        ) as ReadableStream<Uint8Array>;
        await driver.writeStream(path, body);
        return path;
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** The words a report is written in, from the reader's own catalog. */
export type ReportKey =
    | "title"
    | "period"
    | "energy"
    | "kwh"
    | "cost"
    | "day"
    | "load"
    | "avgLoad"
    | "maxLoad"
    | "minCharge"
    | "events"
    | "noEvents";
export type ReportWords = (
    key: `report.${ReportKey}`,
    values?: Record<string, string | number>
) => string;

/** A period's summary of one UPS, as Markdown for the reader's drive. */
export async function buildReport(
    row: { id: string; name: string; currency: string },
    period: { from: Date; to: Date },
    t: ReportWords
): Promise<string> {
    const [daily, events, loads] = await Promise.all([
        energyRollup([row.id], { unit: "day", from: period.from, to: period.to, tz: "UTC" }),
        prisma.upsEvent.groupBy({
            by: ["kind"],
            where: { upsId: row.id, ts: { gte: period.from, lt: period.to } },
            _count: true
        }),
        prisma.upsSample.aggregate({
            where: { upsId: row.id, ts: { gte: period.from, lt: period.to } },
            _avg: { load: true, charge: true },
            _max: { load: true },
            _min: { charge: true }
        })
    ]);
    const totals = energyTotals(daily);
    const n = (value: number | null | undefined, digits = 1) =>
        value === null || value === undefined ? "-" : value.toFixed(digits);
    const lines = [
        `# ${t("report.title", { name: row.name })}`,
        "",
        t("report.period", {
            from: period.from.toISOString().slice(0, 10),
            to: new Date(period.to.getTime() - 1).toISOString().slice(0, 10)
        }),
        "",
        `## ${t("report.energy")}`,
        "",
        `- ${t("report.kwh", { value: totals.kwh.toFixed(3) })}`,
        ...totals.costs
            .filter((one) => one.cost > 0)
            .map(
                (one) =>
                    `- ${t("report.cost", { value: one.cost.toFixed(2), currency: one.currency })}`
            ),
        "",
        `| ${t("report.day")} | kWh |`,
        "| --- | ---: |",
        ...daily.map((one) => `| ${one.ts.slice(0, 10)} | ${one.kwh.toFixed(3)} |`),
        "",
        `## ${t("report.load")}`,
        "",
        `- ${t("report.avgLoad", { value: n(loads._avg.load) })}`,
        `- ${t("report.maxLoad", { value: n(loads._max.load) })}`,
        `- ${t("report.minCharge", { value: n(loads._min.charge, 0) })}`,
        "",
        `## ${t("report.events")}`,
        "",
        ...(events.length === 0
            ? [t("report.noEvents")]
            : events.map((one) => `- ${one.kind}: ${one._count}`)),
        ""
    ];
    return lines.join("\n");
}
