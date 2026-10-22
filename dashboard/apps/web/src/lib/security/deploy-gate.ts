/**
 * The deploy check, as Vercel warns on a vulnerable framework: a release whose
 * image has a critical vulnerability with a known fix is marked with a warning,
 * and a service set to block such releases does not start it unless that one
 * deployment was let through on purpose (recorded on the deployment).
 *
 * WHEN it runs, honestly: after the image is built or pulled and pinned, and
 * before the new containers start and the edge is moved onto them. A scan takes
 * minutes (the image is exported and matched), and a deploy must not stall on
 * it, so the check never waits for one: it reads a finished scan of the same
 * image reference on the same server from the last week - a redeploy, a
 * rollback, an image pulled by a tag that was already running there. A release
 * nobody scanned yet goes live, and the scan that runs once it is live (see
 * the security scans' new-release path) is what reports it, in the bell.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";

/** How old a scan of the same reference may be and still decide. */
const SCAN_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface GateFinding {
    readonly title: string;
    readonly location: string;
    readonly fixedIn: string | null;
    readonly severity: string;
}

export interface GateWarning {
    readonly count: number;
    readonly id: string;
    readonly package: string;
    readonly fixedIn: string;
    readonly scanId: string;
}

/** What a scan's findings mean for a release. Pure. */
export function decideGate(
    findings: readonly GateFinding[],
    options: { scanId: string; block: boolean; overridden: boolean }
): { warning: GateWarning | null; refuse: boolean } {
    const serious = findings.filter((f) => f.severity === "critical" && Boolean(f.fixedIn));
    if (serious.length === 0) return { warning: null, refuse: false };
    const first = serious[0]!;
    return {
        warning: {
            count: serious.length,
            id: first.title,
            package: first.location,
            fixedIn: first.fixedIn!,
            scanId: options.scanId
        },
        refuse: options.block && !options.overridden
    };
}

/** The sentence a refused release fails with, in the deploy log and history. */
export function refusalReason(warning: GateWarning): string {
    return `its image has ${warning.count} critical vulnerabilit${warning.count === 1 ? "y" : "ies"} with a known fix (${warning.id} in ${warning.package}, fixed in ${warning.fixedIn}). This service blocks such releases; deploy it anyway from the deployment, or update the image.`;
}

/**
 * Check one release before it starts. Records the warning on the deployment
 * and answers the refusal, or null to go on. Any failure to read is a pass:
 * the check only ever adds a warning to what would have happened anyway.
 */
export async function checkReleaseImage(input: {
    deploymentId: string;
    targetId: string;
    refs: readonly string[];
}): Promise<string | null> {
    try {
        const refs = [...new Set(input.refs.filter(Boolean))];
        if (refs.length === 0) return null;
        const scan = await prisma.securityScan.findFirst({
            where: {
                targetId: input.targetId,
                kind: "image",
                state: "done",
                createdAt: { gt: new Date(Date.now() - SCAN_WINDOW_MS) },
                OR: refs.map((ref) => ({ input: { contains: JSON.stringify(ref) } }))
            },
            orderBy: { createdAt: "desc" },
            select: { id: true }
        });
        if (!scan) return null;
        const deployment = await prisma.deployment.findUnique({
            where: { id: input.deploymentId },
            select: { deployableType: true, deployableId: true, securityOverrideAt: true }
        });
        if (!deployment || deployment.deployableType !== "application") return null;
        const [findings, app] = await Promise.all([
            prisma.securityFinding.findMany({
                where: { scanId: scan.id, severity: "critical", fixedIn: { not: null } },
                orderBy: { position: "asc" },
                take: 50,
                select: { title: true, location: true, fixedIn: true, severity: true }
            }),
            prisma.application.findUnique({
                where: { id: deployment.deployableId },
                select: { blockVulnerableDeploys: true }
            })
        ]);
        const decision = decideGate(findings, {
            scanId: scan.id,
            block: app?.blockVulnerableDeploys ?? false,
            overridden: Boolean(deployment.securityOverrideAt)
        });
        if (!decision.warning) return null;
        await prisma.deployment.update({
            where: { id: input.deploymentId },
            data: { securityWarning: JSON.stringify(decision.warning) }
        });
        return decision.refuse ? refusalReason(decision.warning) : null;
    } catch (caught) {
        console.error(`polaris: deploy image check for ${input.deploymentId}:`, caught);
        return null;
    }
}
