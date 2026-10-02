/**
 * Networks of the operator's own that a service joins.
 *
 * A server Polaris is brought to often already runs things that reach each other
 * by name over a Docker network nobody here made - `http://dymo-api:3050` on
 * `app_network`. A service moved onto Polaris has to stay on that network, under
 * the names those things call it by, or every one of them loses it.
 *
 * Polaris never creates or removes such a network: it is declared external, so a
 * deploy fails in words if it is missing rather than making an empty one, and
 * taking the service down leaves it where it was. The names it answers to there
 * are set on that network only - on the shared proxy network a short name would
 * answer for another project's service too.
 */

import { prisma } from "@polaris/db";
import { externalNetworksSchema, type ExternalNetwork } from "./external-networks-schema";

export { externalNetworksSchema, type ExternalNetwork } from "./external-networks-schema";

/** The stored list, or none when it is missing or no longer reads as one. */
export function storedExternalNetworks(raw: string | null | undefined): ExternalNetwork[] {
    try {
        const parsed = externalNetworksSchema.safeParse(JSON.parse(raw || "[]"));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

/** What a deploy plan carries for them: the networks to join, and on each, the
 *  names it answers to there. */
export function externalNetworkPlan(list: readonly ExternalNetwork[]): {
    networks: string[];
    aliases: Record<string, string[]>;
} {
    return {
        networks: list.map((entry) => entry.name),
        aliases: Object.fromEntries(
            list.filter((entry) => entry.aliases.length > 0).map((entry) => [entry.name, [...entry.aliases]])
        )
    };
}

/** Save the networks a service joins. The next deploy joins them. */
export async function setExternalNetworks(
    applicationId: string,
    ownerId: string,
    list: readonly ExternalNetwork[]
): Promise<boolean> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { externalNetworks: true }
    });
    if (!app) throw new Error("Application not found");
    const next = JSON.stringify(list);
    if (JSON.stringify(storedExternalNetworks(app.externalNetworks)) === next) return false;
    await prisma.application.update({ where: { id: applicationId }, data: { externalNetworks: next } });
    return true;
}
