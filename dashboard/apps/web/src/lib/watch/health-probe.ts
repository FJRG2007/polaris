/**
 * Domain health probe. Periodically fetches each enabled domain and records
 * whether it actually serves, so a free subdomain that resolves but returns
 * nothing (LAN-only, app down, 5xx) is marked down instead of being shown as if
 * it works. Up = an HTTP response with status < 500; down = a 5xx, a network
 * error, or a timeout. A redirect (e.g. to a login page) still counts as up.
 *
 * A sustained outage also raises an alert to whoever is answerable for the service.
 * Recording it was never enough on its own: nobody watches a status column, and the
 * page it is on is the one you open only after you already know something is wrong.
 */

import { prisma } from "@polaris/db";
import { notifyDomainHealthChanged } from "@/lib/notifications/domain-events";

const PROBE_TIMEOUT_MS = 6000;
const PROBE_CONCURRENCY = 6;

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
}

/** The health columns a transition is decided from, as stored before this probe. */
interface HealthState {
    healthFailures: number;
    healthAlertedAt: Date | null;
}

/** Probe one domain and return its health without persisting. */
export async function checkDomain(target: ProbeTarget): Promise<DomainHealth> {
    const url = `${target.https ? "https" : "http"}://${target.hostname}${target.pathPrefix ?? ""}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const started = Date.now();
    try {
        const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
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
            healthAlertedAt: true
        }
    });
    for (let i = 0; i < domains.length; i += PROBE_CONCURRENCY) {
        await Promise.all(
            domains
                .slice(i, i + PROBE_CONCURRENCY)
                .map((domain) =>
                    checkDomain(domain)
                        .then((health) => persistHealth(domain.id, domain, health))
                        .catch(() => undefined)
                )
        );
    }
}
