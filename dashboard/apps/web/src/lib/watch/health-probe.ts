/**
 * Domain health probe. Periodically fetches each enabled domain and records
 * whether it actually serves, so a free subdomain that resolves but returns
 * nothing (LAN-only, app down, 5xx) is marked down instead of being shown as if
 * it works. Up = an HTTP response with status < 500; down = a 5xx, a network
 * error, or a timeout. A redirect (e.g. to a login page) still counts as up.
 */

import { prisma } from "@polaris/db";

const PROBE_TIMEOUT_MS = 6000;
const PROBE_CONCURRENCY = 6;

interface ProbeTarget {
    id: string;
    hostname: string;
    https: boolean;
    pathPrefix: string | null;
}

export interface DomainHealth {
    status: "up" | "down";
    code: number | null;
    latencyMs: number;
    detail: string | null;
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

/** Probe one domain by id and persist its health. */
export async function probeDomain(target: ProbeTarget): Promise<DomainHealth> {
    const health = await checkDomain(target);
    await prisma.domain.update({
        where: { id: target.id },
        data: {
            healthStatus: health.status,
            healthCode: health.code,
            healthLatencyMs: health.latencyMs,
            healthDetail: health.detail,
            healthCheckedAt: new Date()
        }
    });
    return health;
}

/** Probe every enabled domain, with bounded concurrency. */
export async function probeAllDomains(): Promise<void> {
    const domains = await prisma.domain.findMany({
        where: { enabled: true },
        select: { id: true, hostname: true, https: true, pathPrefix: true }
    });
    for (let i = 0; i < domains.length; i += PROBE_CONCURRENCY) {
        await Promise.all(domains.slice(i, i + PROBE_CONCURRENCY).map((domain) => probeDomain(domain).catch(() => undefined)));
    }
}
