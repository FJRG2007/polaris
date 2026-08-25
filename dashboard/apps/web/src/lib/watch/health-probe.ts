/**
 * Domain health probe. Periodically fetches each enabled domain and records
 * whether it actually serves, so a free subdomain that resolves but returns
 * nothing (LAN-only, app down, 5xx) is marked down instead of being shown as if
 * it works. Up = an HTTP response with status < 500; down = a 5xx, a network
 * error, a timeout, or the edge answering that it routes this name nowhere. A
 * redirect (e.g. to a login page) still counts as up.
 *
 * A sustained outage also raises an alert to whoever is answerable for the service.
 * Recording it was never enough on its own: nobody watches a status column, and the
 * page it is on is the one you open only after you already know something is wrong.
 */

import { prisma } from "@polaris/db";
import { VACANT_HEADER, VACANT_HEADER_VALUE } from "@polaris/core";
import { notifyDomainHealthChanged } from "@/lib/notifications/domain-events";

const PROBE_TIMEOUT_MS = 6000;
const PROBE_CONCURRENCY = 6;

/**
 * Traefik's answer when no router claims the hostname, verbatim: Go's `http.NotFound`,
 * plain text, nineteen bytes. It is worth matching on because it is the one 404 that
 * did not come from anything deployed - the request never reached a service at all.
 */
const EDGE_NO_ROUTE = "404 page not found";
/** Enough for that body and nothing else, so an app's own plain-text 404 is not read
 *  into memory to be compared against it. */
const EDGE_NO_ROUTE_MAX_BYTES = 256;

/**
 * Passes to let go by before writing the routes again while the same addresses stay
 * unrouted. Repeating the repair every minute forever is what an address the local edge
 * is not the one serving would otherwise cost - five queries, a rewritten routing file
 * and a log line, on a condition no rewrite of that file can change. One attempt ends the
 * outage this repairs; the rest is a half-hourly retry, for the case where something
 * empties the file again between two passes.
 */
const REPAIR_RETRY_PASSES = 30;

/**
 * Consecutive failures before anybody is told. At the poller's one-minute interval
 * that is roughly three minutes of being down - long enough that a restart, a redeploy
 * or a single dropped packet passes unmentioned, short enough to still be news.
 */
const ALERT_AFTER_FAILURES = 3;

/** Everything a probe needs to dial something. Deliberately not a domain row:
 *  the dashboard's own addresses are checked the same way and have no row. */
export interface ProbeTarget {
    hostname: string;
    https: boolean;
    pathPrefix?: string | null;
}

export interface DomainHealth {
    status: "up" | "down";
    code: number | null;
    latencyMs: number;
    detail: string | null;
    /** Set when the edge itself answered that nothing serves this hostname, rather than
     *  a service answering badly. Not persisted - it is what tells the poller to
     *  republish the routes, since that is a fault Polaris can repair on its own. */
    notRouted?: true;
}

/** The health columns a transition is decided from, as stored before this probe. */
interface HealthState {
    healthFailures: number;
    healthAlertedAt: Date | null;
}

/**
 * Whether this response is the edge saying nothing serves the name, rather than
 * something serving it. Both of these answer below 500 and so used to read as up:
 *
 * - Traefik's own `404 page not found`, returned when no router matches the hostname.
 *   That is the shape of a route that went missing - the file the app routes live in
 *   emptied by a failed write, a domain that was never published - and it is the outage
 *   nobody was ever told about, because a 404 looks like an answer.
 * - The vacant page, which says the same thing deliberately for a name in the zone with
 *   nothing deployed on it, and marks itself with a header so it can be recognised.
 *
 * The status is what separates that page from the other thing it is used for. It has two
 * states and carries the same header in both: 404 for a name nothing claims, and 502 for
 * an app that IS routed and is not running - which is also the error page an app router
 * shows for its own 502 and 504. A stopped container is already down by its status, its
 * route exists and is correct, and writing the routing file again would never bring it
 * back, so only the 404 reads as no route.
 *
 * A 404 an app produced is left as up. It answered; which of its paths exist is not
 * this probe's business.
 */
async function edgeSaysNotRouted(response: Response): Promise<boolean> {
    if (response.status !== 404) return false;
    if (response.headers.get(VACANT_HEADER) === VACANT_HEADER_VALUE) return true;
    if (!(response.headers.get("content-type") ?? "").startsWith("text/plain")) return false;
    // A declared length, and a small one. Without the header there is no bound on what
    // reading the body would pull into memory, and the edge always declares this one.
    const length = Number(response.headers.get("content-length") ?? NaN);
    if (!(length > 0 && length <= EDGE_NO_ROUTE_MAX_BYTES)) return false;
    return (await response.text().catch(() => "")).trim() === EDGE_NO_ROUTE;
}

/** Probe one domain and return its health without persisting. */
export async function checkDomain(target: ProbeTarget): Promise<DomainHealth> {
    const url = `${target.https ? "https" : "http"}://${target.hostname}${target.pathPrefix ?? ""}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const started = Date.now();
    try {
        const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
        if (await edgeSaysNotRouted(response)) {
            return {
                status: "down",
                code: response.status,
                latencyMs: Date.now() - started,
                detail: "Not routed at the edge",
                notRouted: true
            };
        }
        const status: "up" | "down" = response.status < 500 ? "up" : "down";
        return {
            status,
            code: response.status,
            latencyMs: Date.now() - started,
            detail: status === "down" ? `HTTP ${response.status}` : null
        };
    } catch (caught) {
        return {
            status: "down",
            code: null,
            latencyMs: Date.now() - started,
            detail: controller.signal.aborted ? "Timed out" : caught instanceof Error ? caught.message : "Unreachable"
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * What this probe changes about a domain's alert state.
 *
 * Pure, so the rule that decides whether somebody gets woken up can be asserted
 * without a database or a clock. `alerted` is null when nothing crossed a threshold -
 * the overwhelmingly common case, since most probes find what the last one found.
 */
export function nextAlertState(
    previous: HealthState,
    health: DomainHealth,
    now: Date
): { failures: number; alertedAt: Date | null; alert: "down" | "up" | null } {
    if (health.status === "down") {
        const failures = previous.healthFailures + 1;
        // Only the probe that crosses the threshold alerts. Staying down past it
        // keeps counting and says nothing more.
        const crossing = failures === ALERT_AFTER_FAILURES && previous.healthAlertedAt === null;
        return {
            failures,
            alertedAt: crossing ? now : previous.healthAlertedAt,
            alert: crossing ? "down" : null
        };
    }
    // Recovery is only news to somebody who was told about the outage. A domain that
    // blipped below the threshold and came back has nothing to announce.
    const recovered = previous.healthAlertedAt !== null;
    return { failures: 0, alertedAt: null, alert: recovered ? "up" : null };
}

/** What the poller carries between passes about a repair it already attempted.
 *  `passesSinceAttempt` is null while every address is routed. */
export interface RepairState {
    passesSinceAttempt: number | null;
}

/** Nothing unrouted, nothing attempted: where a poller starts. */
export const NO_REPAIR: RepairState = { passesSinceAttempt: null };

/**
 * Whether this pass should write the routes again.
 *
 * Pure, so the damping can be asserted without a poller or a clock. The repair is
 * idempotent but not free, and what it repairs is either gone by the next pass or was
 * never a missing route - so it fires once when the outage appears, then at the retry
 * interval for as long as it lasts, and arms itself again the moment everything is routed.
 */
export function nextRepairState(previous: RepairState, unrouted: boolean): { state: RepairState; republish: boolean } {
    if (!unrouted) return { state: NO_REPAIR, republish: false };
    if (previous.passesSinceAttempt === null) return { state: { passesSinceAttempt: 0 }, republish: true };
    const passes = previous.passesSinceAttempt + 1;
    if (passes >= REPAIR_RETRY_PASSES) return { state: { passesSinceAttempt: 0 }, republish: true };
    return { state: { passesSinceAttempt: passes }, republish: false };
}

/** Probe one domain by id and persist its health, alerting on a sustained change. */
export async function probeDomain(target: ProbeTarget & { id: string }): Promise<DomainHealth> {
    const previous = await prisma.domain.findUnique({
        where: { id: target.id },
        select: { healthFailures: true, healthAlertedAt: true }
    });
    return persistHealth(target.id, previous ?? { healthFailures: 0, healthAlertedAt: null }, await checkDomain(target));
}

/** Write one probe's result and raise the alert when it crossed a threshold. */
async function persistHealth(id: string, previous: HealthState, health: DomainHealth): Promise<DomainHealth> {
    const next = nextAlertState(previous, health, new Date());
    await prisma.domain.update({
        where: { id },
        data: {
            healthStatus: health.status,
            healthCode: health.code,
            healthLatencyMs: health.latencyMs,
            healthDetail: health.detail,
            healthCheckedAt: new Date(),
            healthFailures: next.failures,
            healthAlertedAt: next.alertedAt
        }
    });
    // After the write, so a delivery that hangs cannot hold the streak back and alert
    // the same outage twice on the next pass.
    if (next.alert) {
        await notifyDomainHealthChanged({ domainId: id, status: next.alert, detail: health.detail });
    }
    return health;
}

/**
 * Write the edge's app routes again, after a probe found a hostname the edge routes
 * nowhere.
 *
 * A missing route is the one outage on this page that Polaris caused and Polaris can
 * undo, and nothing on any screen offers to - so an operator told about it could only
 * wait for something else to happen to trigger a resync.
 *
 * Imported here rather than at the top: the deploy service reaches most of the control
 * plane, and this module is loaded by a poller that starts before any of it is needed.
 */
async function republishAppRoutes(): Promise<void> {
    const { syncAppRoutes } = await import("@/lib/deploy-service");
    await syncAppRoutes();
}

/** Carried between passes, so an address that stays unrouted is not repaired every minute. */
let repair: RepairState = NO_REPAIR;

/** Probe every enabled domain, with bounded concurrency. */
export async function probeAllDomains(): Promise<void> {
    const domains = await prisma.domain.findMany({
        where: { enabled: true },
        select: {
            id: true,
            hostname: true,
            https: true,
            pathPrefix: true,
            healthFailures: true,
            healthAlertedAt: true,
            application: { select: { target: { select: { kind: true } } } }
        }
    });
    let repairable = false;
    for (let i = 0; i < domains.length; i += PROBE_CONCURRENCY) {
        const batch = await Promise.all(
            domains
                .slice(i, i + PROBE_CONCURRENCY)
                .map((domain) =>
                    checkDomain(domain)
                        .then((health) => persistHealth(domain.id, domain, health))
                        // Repairable only where the local edge is the one that serves the address.
                        // An app on a remote server is served by that server's own edge and is
                        // deliberately kept out of the local routing file, so it answers the same
                        // 404 permanently and rewriting that file is not what it is waiting for.
                        .then((health) => health.notRouted === true && domain.application.target.kind === "local")
                        .catch(() => false)
                )
        );
        if (batch.some(Boolean)) repairable = true;
    }
    // Once for the pass, however many names were affected: they share one routing file.
    const next = nextRepairState(repair, repairable);
    repair = next.state;
    if (next.republish) {
        await republishAppRoutes().catch((error) =>
            console.error("polaris: republishing the edge routes after an unrouted address failed:", error)
        );
    }
}
