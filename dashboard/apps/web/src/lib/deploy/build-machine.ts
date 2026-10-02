/**
 * Which machine builds a service's image.
 *
 * By default the one that runs it, as every deploy always has. A service can name
 * another: the Polaris host, or any other connected server - the small machine
 * that runs a service need not be the one with the room and the cores to build
 * it. The image is built and kept there, then carried over (see `runtime/ship` in
 * the deploy package).
 *
 * Stored as `buildOn` in the service's build settings: "local" for the Polaris
 * host, a server's id, `pool:<id>` for the machine a runner pool runs on, or
 * nothing for where it runs. A pool is followed rather than copied: move the pool
 * to another server and the builds go with it. Only a build from source has
 * anything to build; an image source is pulled where it runs whatever this says.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import type { TargetRow } from "./runtime";
import { readerWords } from "@/lib/i18n/reader-words";

/** The choice as it is sent and stored: nothing, the Polaris host, or a server. */
export const buildOnSchema = z.union([
    z.literal(""),
    z.literal("local"),
    z.string().uuid(),
    z.string().regex(/^pool:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
]);

/** The pool a choice names, or null when it names none. */
function poolOf(choice: string): string | null {
    return choice.startsWith("pool:") ? choice.slice(5) : null;
}
export type BuildOn = z.infer<typeof buildOnSchema>;

/** How the log names the Polaris host. */
const POLARIS_HOST = "the Polaris host";

/** The stored choice, or "" when there is none or it no longer reads as one. */
export function storedBuildOn(buildConfig: string | null | undefined): BuildOn {
    try {
        const parsed = buildOnSchema.safeParse((JSON.parse(buildConfig || "{}") as { buildOn?: unknown }).buildOn ?? "");
        return parsed.success ? parsed.data : "";
    } catch {
        return "";
    }
}

/** The machine a build runs on, when it is not the one the service runs on. */
export interface BuildMachine {
    /** Enough of a target to open ports to it; never a stored row. */
    readonly target: TargetRow;
    readonly name: string;
    /** The machine that runs the service, as the log names it. */
    readonly runsOn: string;
}

type RunsOn = { kind: string; hostId: string | null; name: string };

function runsLocally(target: RunsOn): boolean {
    return target.kind === "local" || !target.hostId;
}

/**
 * The machine a service's source build goes to, or null to build where it runs -
 * which is also the answer when the choice names the machine it runs on anyway.
 * A server that has been disconnected since is refused in words rather than
 * quietly built around.
 */
export async function resolveBuildMachine(
    app: { buildConfig: string; target: RunsOn },
    ownerId: string
): Promise<BuildMachine | null> {
    const choice = storedBuildOn(app.buildConfig);
    if (!choice) return null;
    const local = runsLocally(app.target);
    const runsOn = local ? POLARIS_HOST : app.target.name;
    const poolId = poolOf(choice);
    if (poolId) {
        const pool = await prisma.runnerPool.findFirst({
            where: { id: poolId, ownerId },
            select: { name: true, hostId: true, host: { select: { name: true } } }
        });
        if (!pool) {
            throw new Error("The runner pool this service builds on no longer exists. Choose another under its settings.");
        }
        const name = `${pool.name} (${pool.host?.name ?? POLARIS_HOST})`;
        if (!pool.hostId) {
            if (local) return null;
            return {
                target: { id: "build:local", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "" },
                name,
                runsOn
            };
        }
        if (!local && app.target.hostId === pool.hostId) return null;
        return {
            target: { id: `build:${pool.hostId}`, kind: "host", hostId: pool.hostId, runtime: "compose", proxyNetwork: "" },
            name,
            runsOn
        };
    }
    if (choice === "local") {
        if (local) return null;
        return {
            target: { id: "build:local", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "" },
            name: POLARIS_HOST,
            runsOn
        };
    }
    if (!local && app.target.hostId === choice) return null;
    const host = await prisma.host.findFirst({ where: { id: choice, ownerId }, select: { id: true, name: true } });
    if (!host) {
        throw new Error("The server this service builds on is no longer connected. Choose another under its settings.");
    }
    return {
        target: { id: `build:${host.id}`, kind: "host", hostId: host.id, runtime: "compose", proxyNetwork: "" },
        name: host.name,
        runsOn
    };
}

export interface BuildMachineView {
    readonly value: BuildOn;
    readonly options: readonly { value: BuildOn; label: string }[];
    /** Whether the service builds at all: an image source is pulled where it runs. */
    readonly applies: boolean;
}

/** What a service builds on now, and every machine it could build on. */
export async function buildMachineOptions(applicationId: string, ownerId: string): Promise<BuildMachineView> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: {
            buildConfig: true,
            sourceType: true,
            target: { select: { kind: true, hostId: true, name: true } }
        }
    });
    if (!app) throw new Error("Application not found");
    const hosts = await prisma.host.findMany({
        where: { ownerId },
        select: { id: true, name: true },
        orderBy: { name: "asc" }
    });
    const local = runsLocally(app.target);
    const t = await readerWords("deployService");
    const options: { value: BuildOn; label: string }[] = [{ value: "", label: t("buildMachine.itsServer") }];
    if (!local) options.push({ value: "local", label: t("buildMachine.polarisHost") });
    for (const host of hosts) {
        if (!local && host.id === app.target.hostId) continue;
        options.push({ value: host.id, label: host.name });
    }
    const pools = await prisma.runnerPool.findMany({
        where: { ownerId },
        select: { id: true, name: true, host: { select: { name: true } } },
        orderBy: { name: "asc" }
    });
    for (const pool of pools) {
        options.push({
            value: `pool:${pool.id}`,
            label: t("buildMachine.pool", { name: pool.name, server: pool.host?.name ?? t("buildMachine.polarisHost") })
        });
    }
    const value = storedBuildOn(app.buildConfig);
    return {
        value: options.some((option) => option.value === value) ? value : "",
        options,
        applies: app.sourceType === "dockerfile" || app.sourceType === "nixpacks"
    };
}

/** Choose where a service builds. The next deploy uses it. */
export async function setBuildMachine(applicationId: string, ownerId: string, value: BuildOn): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { buildConfig: true }
    });
    if (!app) throw new Error("Application not found");
    const poolId = poolOf(value);
    if (poolId) {
        const pool = await prisma.runnerPool.findFirst({ where: { id: poolId, ownerId }, select: { id: true } });
        if (!pool) throw new Error("That runner pool does not exist");
    } else if (value && value !== "local") {
        const host = await prisma.host.findFirst({ where: { id: value, ownerId }, select: { id: true } });
        if (!host) throw new Error("That server is not connected");
    }
    let build: Record<string, unknown> = {};
    try {
        build = JSON.parse(app.buildConfig || "{}") as Record<string, unknown>;
    } catch {
        build = {};
    }
    if (value) build.buildOn = value;
    else delete build.buildOn;
    await prisma.application.update({
        where: { id: applicationId },
        data: { buildConfig: JSON.stringify(build) }
    });
}
