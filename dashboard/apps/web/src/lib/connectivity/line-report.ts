/**
 * Reading the line back for the screen and the tools: the range's chart points,
 * its totals, the line's state now, and the public address's changes.
 *
 * The last day is drawn from the raw minutes; anything longer from the hourly
 * sums, so a 90-day chart reads at most about 2,200 rows. Server-only.
 */

import { prisma } from "@polaris/db";
import * as rules from "./line-samples";
import { lineState } from "./line-sampler";

export type { LineReport, PublicIpChangeView } from "./line-samples";

/** The most address changes sent; a line that changes more often than this in a year is its own story. */
const IP_LIMIT = 200;

export async function lineReport(range: rules.LineRange, at = Date.now()): Promise<rules.LineReport> {
    const { spanMs } = rules.RANGE_SPEC[range];
    const from = at - spanMs;
    const raw = range === "24h";
    const [rows, ips, state] = await Promise.all([
        raw
            ? prisma.connectivitySample
                  .findMany({
                      where: { at: { gte: new Date(from) } },
                      orderBy: { at: "asc" },
                      take: 2000,
                      select: { at: true, up: true, dnsOk: true, latencyMs: true, lossPct: true }
                  })
                  .then((samples) =>
                      samples.map((sample) => ({
                          at: sample.at.getTime(),
                          sum: rules.sumOfSample(sample)
                      }))
                  )
            : prisma.connectivityHour
                  .findMany({
                      where: { bucket: { gte: new Date(rules.hourOf(from)) } },
                      orderBy: { bucket: "asc" },
                      take: 2400
                  })
                  .then((hours) =>
                      hours.map(({ bucket, ...sum }) => ({ at: bucket.getTime(), sum }))
                  ),
        prisma.publicIpChange.findMany({
            orderBy: { at: "desc" },
            take: IP_LIMIT,
            select: { at: true, previous: true, current: true }
        }),
        lineState()
    ]);
    return {
        range,
        from,
        to: at,
        points: rules.lineSeries(rows, range, at),
        totals: rules.lineTotals(rows),
        now:
            state.lastAt === null
                ? null
                : {
                      at: new Date(state.lastAt).toISOString(),
                      up: state.status === "up",
                      kind: state.kind,
                      since: state.failSince === null ? null : new Date(state.failSince).toISOString(),
                      publicIp: state.publicIp
                  },
        ipChanges: ips.map((change) => ({
            at: change.at.toISOString(),
            previous: change.previous,
            current: change.current
        }))
    };
}
