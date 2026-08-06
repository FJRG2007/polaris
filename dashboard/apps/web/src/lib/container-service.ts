/**
 * Everything the Containers app does to one container, behind a single seam.
 *
 * A Containers connection is one of three things - the local host brokered by
 * polaris-hostd, a registered server reached over SSH, or a stored Docker
 * connection - and they do not all reach a container the same way. The local
 * host has no Docker socket in this container at all: reads go through the
 * daemon's allowlisted proxy, and a shell or a file listing goes through its own
 * exec/fs endpoints, which is why the web container never gains the ability to
 * `docker exec` anything through the proxy. Every other transport is a byte
 * stream, so the Engine API serves the whole set directly.
 *
 * Callers work in connection ids and container ids and get the same answers
 * either way; which mechanism ran is not their problem. Every resolver here is
 * owner-scoped (or manage-gated, for the host-wide local engine), and every one
 * disposes its driver.
 */

import { HostdClient } from "@polaris/hostd-client";
import type { ContainerDetail, ContainerStats, DockerDriver } from "@polaris/docker";
import {
    getDockerDriver,
    hostDockerDriver,
    HOST_DOCKER_PREFIX,
    localDockerDriver,
    LOCAL_DOCKER_CONNECTION_ID
} from "@/lib/docker-service";

/** One entry in a container's filesystem. */
export interface ContainerFileEntry {
    readonly name: string;
    readonly isDir: boolean;
}

/** How a connection reaches its containers. `hostd` is the local engine brokered
 *  by the daemon; `engine` is a direct Docker API transport. */
export type ContainerAccess = "hostd" | "engine";

export function accessFor(connectionId: string): ContainerAccess {
    return connectionId === LOCAL_DOCKER_CONNECTION_ID ? "hostd" : "engine";
}

/**
 * Resolve a connection to a live driver, run one operation, and always dispose.
 * The local host is host-wide rather than owned, so its caller must have already
 * established that this user may manage the system; everything else is scoped to
 * the owner by the resolver it goes through.
 */
export async function withDockerDriver<T>(
    connectionId: string,
    userId: string,
    run: (driver: DockerDriver) => Promise<T>
): Promise<T> {
    const driver =
        connectionId === LOCAL_DOCKER_CONNECTION_ID
            ? localDockerDriver()
            : connectionId.startsWith(HOST_DOCKER_PREFIX)
              ? await hostDockerDriver(connectionId.slice(HOST_DOCKER_PREFIX.length), userId)
              : await getDockerDriver(connectionId, userId);
    try {
        return await run(driver);
    } finally {
        await driver.dispose();
    }
}

/** A container's details. `size` also asks what it occupies on disk, which the
 *  daemon answers by walking the filesystem - for a page, not for a refresh. */
export async function inspectContainer(
    connectionId: string,
    userId: string,
    containerId: string,
    options: { size?: boolean } = {}
): Promise<ContainerDetail> {
    return withDockerDriver(connectionId, userId, (driver) => driver.inspect(containerId, options));
}

/** One live sample for one container: CPU, memory, and the bytes it has moved
 *  over the network and to disk. Null for a container that is not running, which
 *  has nothing to sample rather than nothing to report. */
export async function containerStats(
    connectionId: string,
    userId: string,
    containerId: string
): Promise<ContainerStats | null> {
    return withDockerDriver(connectionId, userId, (driver) => driver.stats(containerId).catch(() => null));
}

/** The last `tail` lines a container printed. */
export async function containerLogs(
    connectionId: string,
    userId: string,
    containerId: string,
    tail: number
): Promise<string> {
    if (accessFor(connectionId) === "hostd") {
        const stream = await new HostdClient().deployLogs({ container: containerId, follow: false, tail });
        return streamToString(stream);
    }
    return withDockerDriver(connectionId, userId, (driver) => driver.logs(containerId, tail));
}

/** Remove a container. Stopping it first is the caller's choice: `force` is what
 *  makes removing a running one possible at all. */
export async function removeContainer(
    connectionId: string,
    userId: string,
    containerId: string,
    options: { force: boolean; volumes: boolean }
): Promise<void> {
    await withDockerDriver(connectionId, userId, (driver) => driver.remove(containerId, options));
}

/**
 * List a directory inside a container. `ls -1Ap` marks directories with a
 * trailing slash, which is all the browser needs to navigate; the local host
 * runs it through the daemon's allowlisted fs endpoint rather than a general
 * exec, so the web container cannot turn the file browser into a shell.
 */
export async function listFiles(
    connectionId: string,
    userId: string,
    containerId: string,
    path: string
): Promise<ContainerFileEntry[]> {
    const target = normalizePath(path);
    const output =
        accessFor(connectionId) === "hostd"
            ? await streamToString(await new HostdClient().fsRead(containerId, ["ls", "-1Ap", "--", target]))
            : await execOrThrow(connectionId, userId, containerId, ["ls", "-1Ap", "--", target]);
    return output
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .map((line) => (line.endsWith("/") ? { name: line.slice(0, -1), isDir: true } : { name: line, isDir: false }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

/** The contents of one file inside a container, for preview and download. */
export async function readFile(
    connectionId: string,
    userId: string,
    containerId: string,
    path: string
): Promise<Buffer> {
    const target = normalizePath(path);
    if (accessFor(connectionId) === "hostd") {
        return streamToBuffer(await new HostdClient().fsRead(containerId, ["cat", "--", target]));
    }
    return Buffer.from(await execOrThrow(connectionId, userId, containerId, ["cat", "--", target]), "utf8");
}

/** Run a read-only command over the Engine API and insist it succeeded. A failed
 *  `ls` says why (no such directory, permission denied), which is what the file
 *  browser shows instead of an empty folder that looks like an empty folder. */
async function execOrThrow(
    connectionId: string,
    userId: string,
    containerId: string,
    argv: readonly string[]
): Promise<string> {
    const result = await withDockerDriver(connectionId, userId, (driver) => driver.exec(containerId, argv));
    if (result.code !== 0) {
        const reason = result.stderr.trim() || result.stdout.trim();
        throw new Error(reason || "The command did not run in this container");
    }
    return result.stdout;
}

/** Reject a path the daemon would pass as argv and that could carry a newline or
 *  a NUL into it; default to the container root. */
function normalizePath(path: string): string {
    const trimmed = (path || "/").trim();
    if (trimmed.includes("\0") || trimmed.includes("\n")) throw new Error("Invalid path");
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
    return (await streamToBuffer(stream)).toString("utf8");
}
