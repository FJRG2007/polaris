"use server";

/**
 * The public networking panel's actions: ports a service listens on, a port and a
 * name per domain, what each domain's DNS and certificate say, and TCP proxies.
 *
 * Each one is checked against the project capability the change needs - reading
 * is `project.read`, everything that changes where traffic lands is
 * `domains.manage` - and every input is parsed before it is used.
 */

import { z } from "zod";
import { reply } from "./reply";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as publicNet from "@/lib/deploy/public-networking";
import { requireApplicationAccess, requireDomainAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

const REFUSAL = {
    notFound: "publicNet.notFound",
    badPort: "publicNet.badPort",
    notRenameable: "publicNet.notRenameable",
    badName: "publicNet.badName",
    zoneUnavailable: "publicNet.zoneUnavailable",
    taken: "publicNet.taken",
    renameFailed: "publicNet.renameFailed",
    proxyLimit: "publicNet.proxyLimit",
    rangeFull: "publicNet.rangeFull"
} as const;

async function refusal(caught: unknown, fallback: "publicNet.failed" = "publicNet.failed"): Promise<{ error: string }> {
    if (caught instanceof publicNet.PublicNetRefusal) {
        return { error: await reply(REFUSAL[caught.code], { ...caught.params }) };
    }
    return { error: await reply(fallback) };
}

const idSchema = z.string().uuid();
const portSchema = z.coerce.number().int().min(1).max(65_535);

/** Ports the service listens on, for the target-port picker. */
export async function servicePortsAction(applicationId: string): Promise<publicNet.ServicePorts | { error: string }> {
    const user = await requirePermission("deploy.read");
    const id = idSchema.safeParse(applicationId);
    if (!id.success) return { error: await reply("common.invalidRequest") };
    try {
        const access = await requireApplicationAccess(id.data, user.id, "project.read");
        return await publicNet.serviceListeningPorts(id.data, access.ownerId);
    } catch (caught) {
        return refusal(caught);
    }
}

/** Where each domain's DNS points and what certificate it serves. */
export async function domainReadingsAction(
    applicationId: string
): Promise<{ readings: publicNet.DomainReading[] } | { error: string }> {
    const user = await requirePermission("deploy.read");
    const id = idSchema.safeParse(applicationId);
    if (!id.success) return { error: await reply("common.invalidRequest") };
    try {
        const access = await requireApplicationAccess(id.data, user.id, "project.read");
        return { readings: await publicNet.domainReadings(id.data, access.ownerId) };
    } catch (caught) {
        return refusal(caught);
    }
}

const domainPortSchema = z.object({ domainId: idSchema, port: portSchema });

/** Point one domain at a port of the service. */
export async function setDomainPortAction(input: { domainId: string; port: number }): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = domainPortSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("publicNet.badPort") };
    try {
        const access = await requireDomainAccess(parsed.data.domainId, user.id, "domains.manage");
        await publicNet.setDomainPort(parsed.data.domainId, access.ownerId, parsed.data.port);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.domain.port",
            targetType: "domain",
            targetId: parsed.data.domainId
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return refusal(caught);
    }
}

const hostPortSchema = z.object({
    applicationId: idSchema,
    hostname: z.string().trim().toLowerCase().min(1).max(253),
    port: portSchema
});

/** The same, for a domain just added and known only by its name. */
export async function setDomainPortByHostnameAction(input: {
    applicationId: string;
    hostname: string;
    port: number;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = hostPortSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("publicNet.badPort") };
    try {
        await requireApplicationAccess(parsed.data.applicationId, user.id, "domains.manage");
    } catch (caught) {
        return refusal(caught);
    }
    const domain = await prisma.domain.findFirst({
        where: { applicationId: parsed.data.applicationId, hostname: parsed.data.hostname },
        select: { id: true }
    });
    if (!domain) return { error: await reply("publicNet.notFound") };
    return setDomainPortAction({ domainId: domain.id, port: parsed.data.port });
}

/** Whether a domain's subdomain can be edited, and the zone it sits in. */
export async function renameableDomainAction(
    domainId: string
): Promise<{ zoneHost: string; subdomain: string; zoneLabel: string } | null> {
    const user = await requirePermission("deploy.read");
    const id = idSchema.safeParse(domainId);
    if (!id.success) return null;
    try {
        const access = await requireDomainAccess(id.data, user.id, "project.read");
        const zone = await publicNet.renameableZone(id.data, access.ownerId);
        return zone ? { zoneHost: zone.host, subdomain: zone.subdomain, zoneLabel: zone.label } : null;
    } catch {
        return null;
    }
}

const renameSchema = z.object({
    domainId: idSchema,
    subdomain: z.string().trim().toLowerCase().min(1).max(63)
});

/** Give a generated name a different subdomain in the same zone. */
export async function renameDomainAction(input: {
    domainId: string;
    subdomain: string;
}): Promise<{ error?: string; hostname?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = renameSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("publicNet.badName") };
    try {
        const access = await requireDomainAccess(parsed.data.domainId, user.id, "domains.manage");
        const hostname = await publicNet.renameDomain(parsed.data.domainId, access.ownerId, parsed.data.subdomain);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.domain.rename",
            targetType: "domain",
            targetId: parsed.data.domainId
        });
        revalidatePath(DEPLOY_PATH);
        return { hostname };
    } catch (caught) {
        return refusal(caught);
    }
}

/** The service's TCP proxies and the addresses they are reached on. */
export async function tcpProxiesAction(applicationId: string): Promise<publicNet.TcpProxyView | { error: string }> {
    const user = await requirePermission("deploy.read");
    const id = idSchema.safeParse(applicationId);
    if (!id.success) return { error: await reply("common.invalidRequest") };
    try {
        const access = await requireApplicationAccess(id.data, user.id, "project.read");
        return await publicNet.listTcpProxies(id.data, access.ownerId);
    } catch (caught) {
        return refusal(caught);
    }
}

const proxySchema = z.object({ applicationId: idSchema, port: portSchema });

export async function addTcpProxyAction(input: {
    applicationId: string;
    port: number;
}): Promise<{ error?: string; host?: number }> {
    const user = await requirePermission("deploy.manage");
    const parsed = proxySchema.safeParse(input);
    if (!parsed.success) return { error: await reply("publicNet.badPort") };
    try {
        const access = await requireApplicationAccess(parsed.data.applicationId, user.id, "domains.manage");
        const proxy = await publicNet.addTcpProxy(parsed.data.applicationId, access.ownerId, parsed.data.port);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.tcp_proxy.add",
            targetType: "application",
            targetId: parsed.data.applicationId
        });
        revalidatePath(DEPLOY_PATH);
        return { host: proxy.host };
    } catch (caught) {
        return refusal(caught);
    }
}

export async function removeTcpProxyAction(input: { applicationId: string; port: number }): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = proxySchema.safeParse(input);
    if (!parsed.success) return { error: await reply("publicNet.badPort") };
    try {
        const access = await requireApplicationAccess(parsed.data.applicationId, user.id, "domains.manage");
        await publicNet.removeTcpProxy(parsed.data.applicationId, access.ownerId, parsed.data.port);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.tcp_proxy.remove",
            targetType: "application",
            targetId: parsed.data.applicationId
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return refusal(caught);
    }
}
