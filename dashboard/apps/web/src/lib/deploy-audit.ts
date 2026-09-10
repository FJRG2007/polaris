/**
 * Writing a Deploy action into the audit trail, with the organization it was about.
 *
 * A project on an organization's shelf is that organization's work, and an
 * organization's history is exactly the entries that name it - so a deploy, a
 * variable changed or a person given access to a project that does not carry the
 * organization's id is one its Activity screen never shows. Every Deploy write
 * used to say it or not depending on whether that call site remembered to, and
 * almost none did.
 *
 * So the organization is resolved here, from what the entry is about, and no call
 * site passes it or can forget it. One lookup per entry, which is nothing against
 * a deploy.
 *
 * An entry about something already deleted cannot be resolved afterwards - the
 * row that would name the organization is the one that went - so a deletion
 * passes `orgId` itself, read before the delete.
 */

import { prisma } from "@polaris/db";
import { recordAudit, type AuditEvent } from "@/lib/audit-service";

/** The organization whose project this target belongs to, or null for a personal
 *  project and for anything that is not part of one (a registry login). */
export async function deployTargetOrgId(
    targetType: string | undefined,
    targetId: string | undefined
): Promise<string | null> {
    if (!targetType || !targetId) return null;
    switch (targetType) {
        case "project":
            return (
                (
                    await prisma.project.findUnique({
                        where: { id: targetId },
                        select: { orgId: true }
                    })
                )?.orgId ?? null
            );
        case "environment":
            return (
                (
                    await prisma.environment.findUnique({
                        where: { id: targetId },
                        select: { project: { select: { orgId: true } } }
                    })
                )?.project.orgId ?? null
            );
        case "application":
            return applicationOrgId(targetId);
        case "database":
            return (
                (
                    await prisma.managedDatabase.findUnique({
                        where: { id: targetId },
                        select: {
                            environment: { select: { project: { select: { orgId: true } } } }
                        }
                    })
                )?.environment.project.orgId ?? null
            );
        case "domain": {
            const domain = await prisma.domain.findUnique({
                where: { id: targetId },
                select: { applicationId: true }
            });
            return domain ? applicationOrgId(domain.applicationId) : null;
        }
        case "volume": {
            const volume = await prisma.volume.findUnique({
                where: { id: targetId },
                select: { applicationId: true }
            });
            return volume?.applicationId ? applicationOrgId(volume.applicationId) : null;
        }
        case "deployment": {
            const deployment = await prisma.deployment.findUnique({
                where: { id: targetId },
                select: { deployableType: true, deployableId: true }
            });
            if (!deployment) return null;
            return deployTargetOrgId(
                deployment.deployableType === "application" ? "application" : "database",
                deployment.deployableId
            );
        }
        default:
            return null;
    }
}

async function applicationOrgId(applicationId: string): Promise<string | null> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environment: { select: { project: { select: { orgId: true } } } } }
    });
    return app?.environment.project.orgId ?? null;
}

/**
 * Record a Deploy action. The organization is looked up from the target unless
 * the caller already knows it - which it has to for a deletion.
 *
 * Never throws, like `recordAudit`: a lookup that fails records the entry
 * without the organization rather than failing the action it describes.
 */
export async function recordDeployAudit(event: AuditEvent): Promise<void> {
    const orgId =
        event.orgId ??
        (await deployTargetOrgId(event.targetType, event.targetId).catch(() => null)) ??
        undefined;
    await recordAudit({ ...event, orgId });
}
