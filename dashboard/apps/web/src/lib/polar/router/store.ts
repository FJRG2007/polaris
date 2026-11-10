/**
 * Where routing lives: a person's own on their Polar preferences, and the
 * deployment's default in a setting an administrator writes. A person who set
 * nothing routes by the deployment's; one who set anything routes by their own
 * whole, so a list they emptied on purpose stays empty.
 *
 * Server-only.
 */

import { Prisma, prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    POLAR_ROUTING_DEFAULTS,
    polarRoutingSchema,
    routingOf,
    type PolarRouting
} from "@/lib/polar/routing";

/** The deployment's default routing, as JSON. */
const INSTANCE_KEY = "polar.routing";

/** The deployment's default. Unset or unreadable is the built-in defaults. */
export async function instanceRouting(): Promise<PolarRouting> {
    const raw = await getSetting(INSTANCE_KEY).catch(() => null);
    if (!raw) return POLAR_ROUTING_DEFAULTS;
    try {
        return routingOf(JSON.parse(raw));
    } catch {
        return POLAR_ROUTING_DEFAULTS;
    }
}

export async function setInstanceRouting(routing: PolarRouting): Promise<void> {
    await setSetting(INSTANCE_KEY, JSON.stringify(polarRoutingSchema.parse(routing)));
}

/** A person's own routing, or null when they set none. */
export async function ownRouting(userId: string): Promise<PolarRouting | null> {
    const row = await prisma.polarPreference
        .findUnique({ where: { userId }, select: { routing: true } })
        .catch(() => null);
    if (!row || row.routing === null) return null;
    return routingOf(row.routing);
}

/** The routing a person's calls follow: their own, else the deployment's. */
export async function polarRouting(userId: string): Promise<PolarRouting> {
    return (await ownRouting(userId)) ?? (await instanceRouting());
}

/** Save a person's routing; null goes back to the deployment's. */
export async function setOwnRouting(userId: string, routing: PolarRouting | null): Promise<void> {
    const value =
        routing === null
            ? Prisma.DbNull
            : (polarRoutingSchema.parse(routing) as unknown as Prisma.InputJsonValue);
    await prisma.polarPreference.upsert({
        where: { userId },
        create: { userId, routing: value },
        update: { routing: value }
    });
}
