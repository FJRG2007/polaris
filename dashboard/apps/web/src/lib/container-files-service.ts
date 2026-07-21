/**
 * Browse and transfer files inside a deployed container. On the local host this
 * goes through the host daemon's read-only fs endpoint (a small command allowlist)
 * for listing/reading and its fs write endpoint for uploads - never a shell the
 * web container controls. Remote-target container browsing (over SSH) is a
 * follow-up; here we resolve and serve the local case.
 */

import type { Readable } from "node:stream";
import { prisma } from "@polaris/db";
import { serviceName } from "@polaris/deploy";
import { HostdClient } from "@polaris/hostd-client";

export interface ContainerEntry {
    readonly name: string;
    readonly isDir: boolean;
}

/** Resolve an application to its local container name, checking ownership and that
 *  the target is the local host. Throws a client-safe message otherwise. */
export async function resolveLocalContainer(applicationId: string, ownerId: string): Promise<string> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.target.kind !== "local") {
        throw new Error("Container file browsing is currently supported on the local host only");
    }
    return serviceName(app.environment.project.slug, app.slug, app.id);
}

/** Resolve an application to its local container name WITHOUT an owner check, for
 *  callers that have already authorized access (the Drive routes authorize the
 *  container source in `authorizeDrive` before building its driver). */
export async function resolveContainerName(applicationId: string): Promise<string> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.target.kind !== "local") {
        throw new Error("Container file browsing is currently supported on the local host only");
    }
    return serviceName(app.environment.project.slug, app.slug, app.id);
}

/** List a directory inside the container. Uses `ls -1Ap` so directories carry a
 *  trailing slash; enough to navigate, download, and upload. */
export async function listContainerFiles(
    applicationId: string,
    ownerId: string,
    path: string
): Promise<ContainerEntry[]> {
    const container = await resolveLocalContainer(applicationId, ownerId);
    const stream = await new HostdClient().fsRead(container, ["ls", "-1Ap", "--", normalizePath(path)]);
    const text = await streamToString(stream);
    return text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .map((line) => (line.endsWith("/") ? { name: line.slice(0, -1), isDir: true } : { name: line, isDir: false }));
}

/** Open a readable stream of a file inside the container (for download). */
export async function readContainerFile(
    applicationId: string,
    ownerId: string,
    path: string
): Promise<Readable> {
    const container = await resolveLocalContainer(applicationId, ownerId);
    return new HostdClient().fsRead(container, ["cat", "--", normalizePath(path)]);
}

/** Write a file inside the container from a buffer (upload / host->container). */
export async function writeContainerFile(
    applicationId: string,
    ownerId: string,
    path: string,
    content: Buffer
): Promise<void> {
    const container = await resolveLocalContainer(applicationId, ownerId);
    const stream = await new HostdClient().fsWrite(container, normalizePath(path), content);
    await streamToString(stream);
}

/** Reject shell-hostile paths defensively (the daemon passes them as argv, but a
 *  clean path avoids surprises) and default to root. */
function normalizePath(path: string): string {
    const trimmed = (path || "/").trim();
    if (trimmed.includes("\0") || trimmed.includes("\n")) throw new Error("Invalid path");
    return trimmed;
}

function streamToString(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
    });
}
