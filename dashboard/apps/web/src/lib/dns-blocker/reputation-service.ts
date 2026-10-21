/**
 * The network filter's reputation lookups: asking Dymo about the domains the
 * network asked for, remembering the answers, and handing the flagged ones to
 * the DNS server. The rules are `reputation.ts`'s; this is the I/O.
 *
 * Fails open everywhere. No integration, no key, the budget spent or Dymo not
 * answering all come to nothing being blocked by reputation - the lists and the
 * operator's own rules keep working - and the screen says which it was.
 */

import { prisma } from "@polaris/db";
import { readLogCursor, readSettings, saveLogCursor } from "./service";
import { takeLookup } from "@/lib/reputation-budget";
import { queryLogPath } from "./query-log";
import { writeEngineFiles } from "./engine-files";
import { engineTarget } from "./insights";
import { domainReputation } from "@/lib/integrations/dymo";
import { dnsReputationOn, type DnsSettings } from "./settings";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import {
    LOOKUPS_PER_PASS,
    PUBLISHED_MAX,
    LogSlice,
    cursorAfter,
    logCursorSchema,
    readPlan,
    reputationFiles,
    reputationListPath,
    verdictExpiry,
    type LogCursor,
    type LogSliceRead,
    type ReputationOff
} from "./reputation";

/** The part of Dymo's budget the filter may use: it waits for nobody, so it
 *  leaves the rest to the mail filter and the share links, which do. */
const BUDGET_SHARE = 0.5;

/** How long past its expiry a verdict is kept before it is deleted. */
const verdictAge = 24 * 60 * 60 * 1000;

/** Lookups in a row Dymo may fail before a pass takes it for Dymo being down,
 *  rather than one name it refuses, and leaves those names for the next pass. */
const FAILURES_IN_ROW = 3;

/** One flagged domain as the screen lists it. */
export interface FlaggedDomain {
    readonly domain: string;
    readonly fraud: boolean;
    readonly adult: boolean;
    readonly checkedAt: string;
}

/** Whether lookups can run for these settings, and the key when they can. */
async function lookupAccess(
    settings: DnsSettings
): Promise<{ off: ReputationOff } | { off: null; apiKey: string }> {
    const state = await getIntegrationState("dymo");
    if (!state?.enabled) return { off: "integrationOff" };
    const apiKey = await getIntegrationSecret("dymo");
    if (!apiKey) return { off: "noKey" };
    if (dnsReputationOn(settings.reputation).length === 0) return { off: "noCategory" };
    return { off: null, apiKey };
}

/** Why the screen's reputation switches do nothing yet, or null when they work. */
export async function reputationOff(): Promise<ReputationOff | null> {
    const access = await lookupAccess(await readSettings());
    return access.off;
}

/** Ask about one domain and keep the answer. `budget` when the budget is
 *  spent and `failed` when Dymo did not answer, both leaving the domain
 *  unasked. */
async function check(
    apiKey: string,
    settings: DnsSettings,
    domain: string
): Promise<"checked" | "budget" | "failed"> {
    if (!takeLookup("dymo", BUDGET_SHARE)) return "budget";
    try {
        const verdict = await domainReputation(apiKey, domain, settings.reputation.adult);
        const flagged = verdict.fraud || verdict.adult;
        const data = {
            fraud: verdict.fraud,
            adult: verdict.adult,
            flagged,
            checkedAt: new Date(),
            expiresAt: verdictExpiry(flagged, Date.now())
        };
        await prisma.dnsReputation.upsert({
            where: { domain },
            create: { domain, ...data },
            update: data
        });
        return "checked";
    } catch (error) {
        console.error("polaris: network filter reputation lookup failed:", error);
        return "failed";
    }
}

/** Write each category's file into the DNS server when it changed, and have it
 *  load its lists again. `lookupsOn` false writes them empty: with no key or
 *  the integration off, nothing is blocked by reputation, remembered or not. */
async function publish(settings: DnsSettings, lookupsOn: boolean): Promise<void> {
    const categories = dnsReputationOn(settings.reputation);
    if (categories.length === 0) return;
    const verdicts = lookupsOn
        ? await prisma.dnsReputation.findMany({
              where: { flagged: true, expiresAt: { gt: new Date() } },
              select: { domain: true, fraud: true, adult: true },
              orderBy: { checkedAt: "desc" },
              take: PUBLISHED_MAX
          })
        : [];
    const files = new Map<string, string>();
    for (const [category, text] of reputationFiles(verdicts, categories))
        files.set(reputationListPath(category), text);
    await writeEngineFiles(files);
}

/** Names out of `names` that already have a current verdict, asked in
 *  bounded batches. */
async function alreadyKnown(names: readonly string[]): Promise<Set<string>> {
    const known = new Set<string>();
    for (let at = 0; at < names.length; at += 500) {
        const rows = await prisma.dnsReputation.findMany({
            where: { domain: { in: names.slice(at, at + 500) }, expiresAt: { gt: new Date() } },
            select: { domain: true }
        });
        for (const row of rows) known.add(row.domain);
    }
    return known;
}

/** One file of the log from the cursor, through the runtime's file stream (not
 *  a command, whose output is cut). Null when the file is not there. */
async function readSlice(
    target: Awaited<ReturnType<typeof engineTarget>>,
    step: LogCursor
): Promise<LogSliceRead | null> {
    let stream: ReadableStream<Uint8Array>;
    try {
        stream = await target.ports.readFile(target.container, step.file);
    } catch {
        return null;
    }
    const slice = new LogSlice(step.offset);
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done || !slice.add(value)) break;
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    return slice.finish();
}

/**
 * One pass of the background job: ask about the newest names in today's log
 * that have no current verdict, a bounded batch under the budget, then publish.
 * Never on a request's path.
 */
export async function runReputationPass(): Promise<{ checked: number; skipped?: ReputationOff }> {
    const settings = await readSettings().catch(() => null);
    if (!settings) return { checked: 0 };
    const access = await lookupAccess(settings);
    if (access.off) {
        if (access.off !== "noCategory") await publish(settings, false).catch(() => undefined);
        return { checked: 0, skipped: access.off };
    }

    const target = await engineTarget().catch(() => null);
    if (!target) return { checked: 0 };
    const stored = logCursorSchema.safeParse(await readLogCursor());
    const today = queryLogPath(new Date());
    let checked = 0;
    for (const step of readPlan(stored.success ? stored.data : null, today)) {
        const slice = await readSlice(target, step);
        // A past day's file already deleted: on to today. Today's not there
        // yet: nothing has been asked today.
        if (!slice) {
            if (step.file === today) break;
            continue;
        }
        if (slice.truncated) {
            await saveLogCursor({ file: step.file, offset: 0 });
            break;
        }
        const handled = await alreadyKnown(slice.entries.map((entry) => entry.domain));
        // A name Dymo refuses is passed over, so it cannot hold up every name
        // after it; a run of them is Dymo down, and is asked again next pass.
        const failedRun: string[] = [];
        for (const { domain } of slice.entries) {
            if (handled.has(domain)) continue;
            if (checked >= LOOKUPS_PER_PASS) break;
            const outcome = await check(access.apiKey, settings, domain);
            if (outcome === "budget") break;
            handled.add(domain);
            checked += 1;
            if (outcome === "checked") {
                failedRun.length = 0;
                continue;
            }
            failedRun.push(domain);
            if (failedRun.length < FAILURES_IN_ROW) continue;
            for (const name of failedRun) handled.delete(name);
            break;
        }
        const offset = cursorAfter(slice.entries, handled, slice.end);
        await saveLogCursor({ file: step.file, offset });
        // Stopped short - the budget, or the bytes one pass reads: the next
        // pass goes on from here.
        if (offset < slice.end || !slice.complete) break;
    }
    // A verdict long past asking again is not worth keeping.
    await prisma.dnsReputation.deleteMany({
        where: { expiresAt: { lt: new Date(Date.now() - verdictAge) } }
    });
    await publish(settings, true);
    return { checked };
}

/** The flagged domains, newest first, a bounded page, optionally searched. */
export async function flaggedDomains(search: string): Promise<FlaggedDomain[]> {
    const rows = await prisma.dnsReputation.findMany({
        where: {
            flagged: true,
            expiresAt: { gt: new Date() },
            ...(search ? { domain: { contains: search.toLowerCase() } } : {})
        },
        select: { domain: true, fraud: true, adult: true, checkedAt: true },
        orderBy: { checkedAt: "desc" },
        take: 100
    });
    return rows.map((row) => ({ ...row, checkedAt: row.checkedAt.toISOString() }));
}

/** Ask about one domain again now, and publish what that changed. Refused in
 *  words when lookups are off, the budget is spent or Dymo did not answer. */
export async function recheckDomain(
    domain: string
): Promise<"checked" | ReputationOff | "budget" | "failed"> {
    const settings = await readSettings();
    const access = await lookupAccess(settings);
    if (access.off) return access.off;
    const outcome = await check(access.apiKey, settings, domain);
    if (outcome !== "checked") return outcome;
    await publish(settings, true);
    return "checked";
}

/** Publish again after the settings changed which categories are on. */
export async function republishReputation(): Promise<void> {
    const settings = await readSettings();
    const { off } = await lookupAccess(settings);
    if (off === "noCategory") return;
    await publish(settings, off === null).catch((error: unknown) =>
        console.error("polaris: network filter reputation list not written:", error)
    );
}
