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
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { readSettings } from "./service";
import { takeLookup } from "@/lib/reputation-budget";
import { TAIL_BYTES, queryLogPath } from "./query-log";
import { engineTarget, refreshLists } from "./insights";
import { domainReputation } from "@/lib/integrations/dymo";
import { dnsReputationOn, type DnsSettings } from "./settings";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import {
    LOOKUPS_PER_PASS,
    PUBLISHED_MAX,
    namesFromLog,
    reputationFiles,
    reputationListPath,
    verdictExpiry,
    type ReputationOff
} from "./reputation";

/** The part of Dymo's budget the filter may use: it waits for nobody, so it
 *  leaves the rest to the mail filter and the share links, which do. */
const BUDGET_SHARE = 0.5;

/** How long past its expiry a verdict is kept before it is deleted. */
const verdictAge = 24 * 60 * 60 * 1000;

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

/** Ask about one domain and keep the answer. False when the budget is spent
 *  or Dymo did not answer, which leaves the domain unasked. */
async function check(apiKey: string, settings: DnsSettings, domain: string): Promise<boolean> {
    if (!takeLookup("dymo", BUDGET_SHARE)) return false;
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
        return true;
    } catch (error) {
        console.error("polaris: network filter reputation lookup failed:", error);
        return false;
    }
}

/** The hash of what was last written to each file, so an unchanged set is not
 *  written, nor the lists loaded again, every pass. In memory: a restart
 *  writes the files once more. */
const published = new Map<string, string>();

/** Write each category's file into the DNS server when it changed, and have it
 *  load its lists again. `lookupsOn` false writes them empty: with no key or
 *  the integration off, nothing is blocked by reputation, remembered or not. */
async function publish(settings: DnsSettings, lookupsOn: boolean): Promise<void> {
    const categories = dnsReputationOn(settings.reputation);
    if (categories.length === 0) return;
    const target = await engineTarget();
    if (!target.ports.writeFile) return;
    const verdicts = lookupsOn
        ? await prisma.dnsReputation.findMany({
              where: { flagged: true, expiresAt: { gt: new Date() } },
              select: { domain: true, fraud: true, adult: true },
              orderBy: { checkedAt: "desc" },
              take: PUBLISHED_MAX
          })
        : [];
    let changed = false;
    for (const [category, text] of reputationFiles(verdicts, categories)) {
        const path = reputationListPath(category);
        const key = `${target.container}:${path}`;
        const hash = createHash("sha256").update(text).digest("hex");
        if (published.get(key) === hash) continue;
        const bytes = Buffer.from(text, "utf8");
        await target.ports.writeFile(target.container, path, Readable.from([bytes]), bytes.length);
        published.set(key, hash);
        changed = true;
    }
    if (changed) await refreshLists();
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
    const tail = await target.ports.runIn(target.container, [
        "tail",
        "-c",
        String(TAIL_BYTES),
        queryLogPath(new Date())
    ]);
    const names = tail.code === 0 ? namesFromLog(tail.output, 200) : [];
    const known = names.length
        ? await prisma.dnsReputation.findMany({
              where: { domain: { in: names }, expiresAt: { gt: new Date() } },
              select: { domain: true }
          })
        : [];
    const current = new Set(known.map((row) => row.domain));
    let checked = 0;
    for (const domain of names.filter((name) => !current.has(name))) {
        if (checked >= LOOKUPS_PER_PASS) break;
        if (!(await check(access.apiKey, settings, domain))) break;
        checked += 1;
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
            ...(search ? { domain: { contains: search.toLowerCase() } } : {})
        },
        select: { domain: true, fraud: true, adult: true, checkedAt: true },
        orderBy: { checkedAt: "desc" },
        take: 100
    });
    return rows.map((row) => ({ ...row, checkedAt: row.checkedAt.toISOString() }));
}

/** Ask about one domain again now, and publish what that changed. Refused in
 *  words when lookups are off or the budget is spent. */
export async function recheckDomain(domain: string): Promise<"checked" | ReputationOff | "budget"> {
    const settings = await readSettings();
    const access = await lookupAccess(settings);
    if (access.off) return access.off;
    if (!(await check(access.apiKey, settings, domain))) return "budget";
    await publish(settings, true);
    return "checked";
}

/** Publish again after the settings changed which categories are on. */
export async function republishReputation(): Promise<void> {
    published.clear();
    const settings = await readSettings();
    const { off } = await lookupAccess(settings);
    if (off === "noCategory") return;
    await publish(settings, off === null).catch((error: unknown) =>
        console.error("polaris: network filter reputation list not written:", error)
    );
}
