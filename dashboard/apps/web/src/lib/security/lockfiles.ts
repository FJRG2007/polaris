/**
 * Dependency scanning for Deploy services built from a repository, the way
 * Dependabot reads a lockfile: the lockfiles of the commit being deployed are
 * taken from the deploy's own clone and handed to the security scans, which
 * match them with the same pinned Grype the image scans use (a `dir:` source).
 *
 * Why from the clone, and why it is copied: the clone lives in this
 * container's temp directory only while its build context is read, and is
 * removed straight after; Grype runs on the service's server, behind its
 * daemon, where that directory never exists. So the lockfiles - small, a known
 * list of names - are copied out while the clone is there, stored with a queued
 * scan of kind "deps", and the scan carries them to the server inside a
 * throwaway image built on top of the scanner's (see the security scans'
 * `runDeps`). No second fetch of the repository, so it works for any forge and
 * for private repositories with the credential the deploy already had.
 *
 * Server-only.
 */

import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { prisma } from "@polaris/db";
import { lstat, readFile } from "node:fs/promises";
import {
    encodeLockfiles,
    isLockfilePath,
    lockfileDirs,
    LOCKFILE_NAMES,
    MAX_LOCKFILE_BYTES,
    MAX_STORED_BYTES,
    MAX_TOTAL_BYTES,
    type Lockfile
} from "@polaris/deploy";

/** The same commit of the same service is not scanned twice in this window. */
const SAME_COMMIT_MS = 24 * 60 * 60_000;

/**
 * Read the lockfiles out of a checkout. Only regular files are read - a link is
 * never followed out of the clone - and every bound is kept: per file, in total,
 * and the length of the path.
 */
export async function collectLockfiles(dir: string, rootDirectory: string): Promise<Lockfile[]> {
    const dirs = lockfileDirs(rootDirectory);
    if (!dirs) return [];
    const found: Lockfile[] = [];
    let total = 0;
    for (const sub of dirs) {
        for (const name of LOCKFILE_NAMES) {
            const path = sub ? `${sub}/${name}` : name;
            if (!isLockfilePath(path)) continue;
            const full = join(dir, ...path.split("/"));
            const info = await lstat(full).catch(() => null);
            if (!info?.isFile() || info.size > MAX_LOCKFILE_BYTES) continue;
            if (total + info.size > MAX_TOTAL_BYTES) continue;
            const body = await readFile(full).catch(() => null);
            if (!body) continue;
            total += body.length;
            found.push({ path, body });
        }
    }
    return found;
}

function rootDirectoryOf(sourceConfig: string): string {
    try {
        const value = (JSON.parse(sourceConfig) as { rootDirectory?: unknown }).rootDirectory;
        return typeof value === "string" ? value : "";
    } catch {
        return "";
    }
}

/**
 * Copy a deploy's lockfiles out of its clone and queue their scan. Called with
 * the checkout while it exists; never fails the deploy - a lockfile that could
 * not be read only means its dependencies are not listed this time.
 */
export async function queueDependencyScan(deploymentId: string, dir: string): Promise<void> {
    try {
        const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { deployableType: true, deployableId: true, commitSha: true, targetId: true }
        });
        if (!deployment || deployment.deployableType !== "application") return;
        const app = await prisma.application.findUnique({
            where: { id: deployment.deployableId },
            select: { id: true, name: true, sourceConfig: true }
        });
        if (!app) return;
        const commitSha = deployment.commitSha ?? null;
        if (commitSha) {
            const recent = await prisma.securityScan.findFirst({
                where: {
                    targetId: deployment.targetId,
                    kind: "deps",
                    state: { in: ["queued", "running", "done"] },
                    createdAt: { gt: new Date(Date.now() - SAME_COMMIT_MS) },
                    input: { contains: JSON.stringify(commitSha) },
                    AND: [{ input: { contains: JSON.stringify(app.id) } }]
                },
                select: { id: true }
            });
            if (recent) return;
        }
        const files = await collectLockfiles(dir, rootDirectoryOf(app.sourceConfig));
        if (files.length === 0) return;
        const payload = gzipSync(encodeLockfiles(files));
        if (payload.length > MAX_STORED_BYTES) return;
        await prisma.securityScan.create({
            data: {
                targetId: deployment.targetId,
                kind: "deps",
                label: app.name,
                input: JSON.stringify({
                    applicationId: app.id,
                    deploymentId,
                    commitSha,
                    files: files.map((file) => file.path)
                }),
                payload
            }
        });
    } catch (caught) {
        console.error(`polaris: dependency scan for ${deploymentId} was not queued:`, caught);
    }
}
