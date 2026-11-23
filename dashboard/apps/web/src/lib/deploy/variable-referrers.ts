/**
 * Which services read a variable through a reference - the ones a rotated
 * value has to reach.
 *
 * Changing `API_KEY` on a service changes nothing for a service that reads it
 * as `${{api.API_KEY}}` until that one is deployed again too, which is the
 * step a rotation forgets. This finds every such service in the environment,
 * following a reference of a reference (`b` reads `${{a.KEY}}`, `c` reads
 * `${{b.URL}}`) as far as substitution itself does, and a shared variable that
 * reads it - which every service in the environment gets.
 *
 * The walk is pure (`referrers`); `environmentReferrers` loads one environment
 * for it. Values are opened only here on the server and nothing about them
 * leaves it: the answer is service ids.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { slugify } from "@polaris/deploy";
import { decryptedValue } from "./env-values";

export interface ReferrerService {
    readonly id: string;
    /** Every name a reference may call it by (its slug, its slugified name). */
    readonly names: readonly string[];
    readonly variables: Readonly<Record<string, string>>;
}

/** A name and key whose value changed: `{ name: "api", key: "API_KEY" }`, or `shared`. */
export interface ChangedValue {
    readonly name: string;
    readonly key: string;
}

/**
 * The services that read any changed value, directly or through others, not
 * counting the one changed. `everyone` when a shared variable reads one, since
 * every service gets the shared variables.
 */
export function referrers(
    services: readonly ReferrerService[],
    shared: Readonly<Record<string, string>>,
    changed: readonly ChangedValue[]
): { ids: string[]; everyone: boolean; } {
    const seen = new Set(changed.map((item) => `${item.name}\u0000${item.key}`));
    const reads = (value: string): boolean =>
        core
            .referencesIn(value)
            .some((reference) => seen.has(`${reference.name}\u0000${reference.key}`));
    const found = new Set<string>();
    let everyone = false;
    for (let round = 0; round <= core.REFERENCE_DEPTH; round += 1) {
        const before = seen.size;
        for (const [key, value] of Object.entries(shared)) {
            if (!reads(value)) continue;
            everyone = true;
            seen.add(`shared\u0000${key}`);
        }
        for (const service of services) {
            for (const [key, value] of Object.entries(service.variables)) {
                if (!reads(value)) continue;
                found.add(service.id);
                for (const name of service.names) seen.add(`${name}\u0000${key}`);
            }
        }
        if (seen.size === before) break;
    }
    if (everyone) for (const service of services) found.add(service.id);
    return { ids: [...found], everyone };
}

/**
 * The services of one environment that read any of `keys` of `serviceId`,
 * itself left out. Callers authorize the service first.
 */
export async function environmentReferrers(
    serviceId: string,
    keys: readonly string[]
): Promise<string[]> {
    if (keys.length === 0) return [];
    const service = await prisma.application.findUnique({
        where: { id: serviceId },
        select: { environmentId: true }
    });
    if (!service) return [];
    const applications = await prisma.application.findMany({
        where: { environmentId: service.environmentId },
        select: { id: true, slug: true, name: true }
    });
    const rows = await prisma.envVar.findMany({
        where: {
            OR: [
                { scopeType: "environment", scopeId: service.environmentId },
                { scopeType: "application", scopeId: { in: applications.map((one) => one.id) } }
            ]
        }
    });
    const shared: Record<string, string> = {};
    const byService = new Map<string, Record<string, string>>();
    for (const row of rows) {
        let value: string | null = null;
        try {
            value = decryptedValue(row);
        } catch {
            continue;
        }
        if (!value || !core.hasReferences(value)) continue;
        if (row.scopeType === "environment") shared[row.key] = value;
        else byService.set(row.scopeId, { ...byService.get(row.scopeId), [row.key]: value });
    }
    const namesOf = (one: { slug: string | null; name: string; }): string[] =>
        [...new Set([one.slug, slugify(one.name)].filter((name): name is string => Boolean(name)))];
    const changedService = applications.find((one) => one.id === serviceId);
    if (!changedService) return [];
    const changed = namesOf(changedService).flatMap((name) => keys.map((key) => ({ name, key })));
    const services = applications.map((one) => ({
        id: one.id,
        names: namesOf(one),
        variables: byService.get(one.id) ?? {}
    }));
    return referrers(services, shared, changed).ids.filter((id) => id !== serviceId);
}
