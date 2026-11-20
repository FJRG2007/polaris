"use server";

/** Saving Polar's deployment-wide settings: what its chats may reach, its
 *  default routing, and where Polar Code sessions run. */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { appSettingsPath } from "@/lib/apps/app-settings";
import { getTranslations } from "@/lib/i18n/request";
import { recordAudit } from "@/lib/audit-service";
import { setSetting } from "@/lib/setting-store";
import { INSTANCE_KEY, SHARED_WORKSPACE_KEY } from "@/lib/agents/session-capacity";
import { instanceRouteKeys } from "@/lib/polar/routing-screen";
import { checkRouting, pinnedKeyIds } from "@/lib/polar/routing-keys";
import { instanceRouting, setInstanceRouting } from "@/lib/polar/router/store";
import { polarPolicySchema, savePolarPolicy } from "@/lib/polar/access";
import { poolSchema, writePool } from "@/lib/agents/session-placement";
import { warmSchema, writeWarm } from "@/lib/agents/session-spares";
import { checkReach } from "@/lib/agents/pool-reach";
import { readPool } from "@/lib/agents/session-placement";
import type { Reach } from "@/lib/agents/pool-reach-state";

const saveSchema = z.object({
    pool: poolSchema,
    boxSessions: z.number().int().min(1).max(10_000),
    warm: warmSchema
});

export async function savePolarCodeAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const t = await getTranslations("polar");
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: t("admin.code.errors.invalid") };
    const { pool, boxSessions, warm } = parsed.data;

    // Only servers Polaris can run a container on. Checked here, not trusted
    // from the picker: placement would skip one without an engine forever, and
    // the screen would show it as part of a pool it never serves.
    const ids = pool.servers.map((server) => server.hostId);
    if (ids.length) {
        const found = await prisma.host.count({ where: { id: { in: ids }, dockerId: { not: null } } });
        if (found !== new Set(ids).size) return { error: t("admin.code.errors.noEngine") };
    }

    await Promise.all([
        writePool(pool),
        setSetting(INSTANCE_KEY, String(boxSessions)),
        writeWarm(warm)
    ]);
    await recordAudit({
        actorId: admin.id,
        action: "polar.code.update",
        targetType: "setting",
        targetId: "polar.code",
        metadata: { box: pool.box, boxSessions, servers: pool.servers.length, warm }
    });
    revalidatePath(appSettingsPath("polar"));
    return {};
}

/**
 * Ask a server whether it reaches Polaris, now. Any server with an engine may be
 * asked - one about to be added included - but only a pool server's answer is
 * kept, since that is the only one placement reads.
 */
export async function checkPoolReachAction(hostId: unknown): Promise<{ reach?: Reach; error?: string }> {
    await requireAdmin();
    const t = await getTranslations("polar");
    const parsed = z.string().uuid().safeParse(hostId);
    if (!parsed.success) return { error: t("admin.code.errors.invalid") };
    const host = await prisma.host.findFirst({
        where: { id: parsed.data, dockerId: { not: null } },
        select: { id: true }
    });
    if (!host) return { error: t("admin.code.errors.noEngine") };
    const pool = await readPool();
    const ids = pool.servers.map((server) => server.hostId);
    return { reach: await checkReach(host.id, ids.includes(host.id) ? ids : []) };
}

/**
 * What Polar's chats may reach: the web, the free models, the free stand-in
 * and people's own MCP servers. Who may use Polar is a permission, edited
 * under Management > Roles and Users > Capabilities.
 */
export async function setPolarOptionsAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = polarPolicySchema.safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("agents.errors.pickSetting") };

    const saved = await savePolarPolicy(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "polar.access.update",
        metadata: {
            web: saved.web,
            connectors: saved.connectors.who,
            connectorHosts: saved.connectors.hosts.length,
            connectorPrivateNetwork: saved.connectors.privateNetwork,
            freeModels: saved.freeModels,
            zenStandInEveryone: saved.zenStandInEveryone
        }
    });
    revalidatePath(appSettingsPath("polar"));
    return {};
}

/**
 * The deployment's default routing: what every account that set none of its
 * own falls back through, and what a coding tool's request lands on. Held to
 * the deployment's own keys.
 */
export async function saveInstanceRoutingAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const [keys, current] = await Promise.all([instanceRouteKeys(), instanceRouting()]);
    const checked = checkRouting(input, keys, pinnedKeyIds(current));
    if (!checked.ok) {
        return { error: (await getTranslations("polar"))(`routing.errors.${checked.refusal}`) };
    }
    await setInstanceRouting(checked.routing);
    await recordAudit({
        actorId: admin.id,
        action: "agents.polar.routing",
        metadata: { fallbacks: checked.routing.fallbacks.length }
    });
    revalidatePath(appSettingsPath("polar"));
    return {};
}

/**
 * Whether this deployment offers a machine everybody shares.
 *
 * Off by default and only ever turned on here, because it is the one setting
 * that puts several accounts on one home: what is signed in on that machine is
 * signed in for everybody who can open it. Right for a team on one
 * subscription, wrong for a deployment of separate people, and only an
 * administrator knows which of those this is.
 */
export async function setSharedWorkspaceAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ allowed: z.boolean() }).safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("agents.errors.pickSetting") };

    await setSetting(SHARED_WORKSPACE_KEY, parsed.data.allowed ? "true" : "false");
    await recordAudit({
        actorId: admin.id,
        action: "agents.sessions.sharedWorkspace",
        metadata: { allowed: parsed.data.allowed }
    });
    revalidatePath(appSettingsPath("polar"));
    return {};
}
