/**
 * A Deploy service's dependency findings, as its page shows them: the latest
 * dependency scan of the lockfiles its deploys copied out (see `lockfiles.ts`),
 * and that scan's findings. Read straight from the scans' tables - the
 * dashboard never imports the security scans app.
 *
 * Server-only. The caller checks that the reader may see the service.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";

/** One scan's stored findings are capped at this by the scans themselves. */
const MAX_FINDINGS = 500;

export interface DependencyScanView {
    readonly state: "queued" | "running" | "done" | "failed";
    readonly createdAt: string;
    readonly finishedAt: string | null;
    readonly commitSha: string | null;
    /** The lockfiles it read, relative to the repository. */
    readonly files: readonly string[];
}

export interface DependencyFinding {
    readonly id: string;
    readonly severity: string;
    readonly title: string;
    readonly location: string;
    readonly fixedIn: string | null;
    readonly url: string | null;
    readonly layer: null;
}

const inputSchema = z.object({
    commitSha: z.string().max(80).nullable().catch(null).default(null),
    files: z.array(z.string().max(200)).max(200).catch([]).default([])
});

const stateSchema = z.enum(["queued", "running", "done", "failed"]);

function readInput(raw: string): z.infer<typeof inputSchema> {
    try {
        return inputSchema.parse(JSON.parse(raw));
    } catch {
        return { commitSha: null, files: [] };
    }
}

export async function serviceDependencies(
    applicationId: string
): Promise<{ scan: DependencyScanView | null; findings: DependencyFinding[] }> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { targetId: true }
    });
    if (!app) return { scan: null, findings: [] };
    const scan = await prisma.securityScan.findFirst({
        where: {
            targetId: app.targetId,
            kind: "deps",
            input: { contains: JSON.stringify(applicationId) }
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, state: true, input: true, createdAt: true, finishedAt: true }
    });
    const state = stateSchema.safeParse(scan?.state);
    if (!scan || !state.success) return { scan: null, findings: [] };
    const input = readInput(scan.input);
    const findings =
        state.data === "done"
            ? await prisma.securityFinding.findMany({
                  where: { scanId: scan.id },
                  orderBy: { position: "asc" },
                  take: MAX_FINDINGS,
                  select: {
                      id: true,
                      severity: true,
                      title: true,
                      location: true,
                      fixedIn: true,
                      url: true
                  }
              })
            : [];
    return {
        scan: {
            state: state.data,
            createdAt: scan.createdAt.toISOString(),
            finishedAt: scan.finishedAt?.toISOString() ?? null,
            commitSha: input.commitSha,
            files: input.files
        },
        findings: findings.map((finding) => ({
            ...finding,
            // An advisory link is only ever an https one.
            url: finding.url?.startsWith("https://") ? finding.url : null,
            layer: null
        }))
    };
}
