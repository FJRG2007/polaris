/**
 * Chunk files given back to the owner of the world, once per server.
 *
 * Before 2026-11-21 the world optimizer ran as root and moved every file it
 * rebuilt into place as root's (BUG-0009). The server runs as the owner of the
 * world, so it then failed every save into those files with
 * `AccessDeniedException` - the world stopped saving, silently, for the players.
 * The script keeps owners now; this carries the repair to every Java server that
 * already had a run, without anybody opening a terminal.
 *
 * Only `.mca` files under `region/`, `entities/` and `poi/` of the level, and only
 * to the owner of the level's own `level.dat`. Nothing else is touched.
 *
 *   - A running server is repaired in place through the same exec every other
 *     file fix-up here uses (`makeServerDir`): a change of owner does not touch
 *     the contents, so the server's next save simply succeeds.
 *   - A stopped server is repaired through the optimizer's own route - the
 *     throwaway container on the server's volumes that the daemon refuses to run
 *     while the server is up - with a script that only changes owners.
 *
 * Once a server has been looked at and found right (or put right), a marker in
 * its config means it is never asked again. A failure is retried after a pause.
 */

import { prisma } from "@polaris/db";
import { levelParent } from "./world";
import { host } from "@polaris/app-host";
import { readWorldTrimRun } from "./world-trim";
import { WORLD_OWNER_REPAIR_SCRIPT } from "./world-trim-script";
import { withServerContainer, type ServerContainer } from "./service";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { listEnvVars } = host.envVarService;

/** Set once a server's chunk files are known to belong to the world's owner. */
export const WORLD_OWNERS_KEY = "worldOwnersRepaired";

/** How long a failed attempt waits before it is tried again. */
const RETRY_MS = 6 * 60 * 60 * 1000;

interface OwnersMarker {
    readonly at: string;
    readonly ok: boolean;
    readonly fixed: number;
}

function readMarker(config: Record<string, unknown>): OwnersMarker | null {
    const raw = config[WORLD_OWNERS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.at !== "string") return null;
    return { at: value.at, ok: value.ok === true, fixed: typeof value.fixed === "number" ? value.fixed : 0 };
}

/**
 * Whether this server still needs looking at. Pure.
 *
 * A stopped server that never had an optimizer run is left until it next runs:
 * nothing but that run wrote into its chunk folders as root, and the check of a
 * running one is a single command.
 */
export function ownersRepairDue(
    config: Record<string, unknown>,
    running: boolean,
    now: Date
): "running" | "stopped" | null {
    const marker = readMarker(config);
    if (marker?.ok) return null;
    if (marker && now.getTime() - Date.parse(marker.at) < RETRY_MS) return null;
    if (running) return "running";
    return readWorldTrimRun(config) ? "stopped" : null;
}

/** The level folder name, as the optimizer resolves it. Pure. */
export function levelFolder(level: string | null | undefined): string {
    const name = level?.trim();
    return name && /^[A-Za-z0-9 _.-]{1,64}$/.test(name) && !name.includes("..") ? name : "world";
}

/**
 * The `find` that lists, and changes, chunk files not owned by `uid`. Pure.
 *
 * No shell: an argv the daemon passes straight to exec. `-type f` never matches
 * a link, and the default `-P` never follows one, so nothing outside the level
 * can be reached through a link planted inside it.
 */
export function repairArgv(world: string, uid: string, gid: string): string[] {
    return [
        "find",
        world,
        "-type",
        "f",
        "-name",
        "*.mca",
        "(",
        "-path",
        "*/region/*",
        "-o",
        "-path",
        "*/entities/*",
        "-o",
        "-path",
        "*/poi/*",
        ")",
        "!",
        "-uid",
        uid,
        "-print",
        "-exec",
        "chown",
        `${uid}:${gid}`,
        "{}",
        "+"
    ];
}

/** Repair a running server through its exec. The number of files changed, or null on failure. */
async function repairRunning(server: ServerContainer, world: string): Promise<number | null> {
    const owner = await server.run(["stat", "-c", "%u:%g", "--", `${world}/level.dat`]);
    const match = /^(\d+):(\d+)$/.exec(owner.output.trim());
    if (owner.code !== 0 || !match) return null;
    const [, uid, gid] = match;
    // A world root owns is one whose files root may already write.
    if (uid === "0") return 0;
    const result = await server.run(repairArgv(world, uid!, gid!));
    if (result.code !== 0) return null;
    return result.output.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/** Repair a stopped server through the optimizer's route. */
async function repairStopped(server: ServerContainer, world: string): Promise<number | null> {
    if (!server.trimWorld) return null;
    const result = await server.trimWorld(WORLD_OWNER_REPAIR_SCRIPT, {
        world,
        keepTicks: 0,
        keepRadius: 0,
        dryRun: false
    });
    const line = result.output.trim().split(/\r?\n/).pop() ?? "";
    try {
        const report = JSON.parse(line) as { repair?: boolean; fixed?: number; failed?: number };
        if (result.code !== 0 || report.repair !== true || (report.failed ?? 0) > 0) return null;
        return report.fixed ?? 0;
    } catch {
        return null;
    }
}

export async function repairWorldOwners(now = new Date()): Promise<{ checked: number; fixed: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { catalogId: "minecraft", status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, ownerId: true, applicationId: true, config: true }
    });
    let checked = 0;
    let fixed = 0;
    for (const install of installs) {
        const config = readInstallConfig(install.config);
        const app = await prisma.application
            .findUnique({ where: { id: install.applicationId! }, select: { desiredState: true } })
            .catch(() => null);
        const due = ownersRepairDue(config, app?.desiredState === "running", now);
        if (!due) continue;
        checked += 1;
        // Undefined: nothing could be asked of it this time (down, and never
        // optimized), which is not an attempt and leaves no marker.
        let changed: number | null | undefined = null;
        try {
            const env = await listEnvVars("application", install.applicationId!, install.ownerId).catch(() => []);
            const level = env.find((row: { key: string }) => row.key === "LEVEL")?.value;
            const world = `${levelParent("java")}/${levelFolder(level)}`;
            changed = await withServerContainer(install.ownerId, install.id, async (server) =>
                server.running
                    ? repairRunning(server, world)
                    : readWorldTrimRun(config)
                      ? repairStopped(server, world)
                      : undefined
            );
        } catch (caught) {
            console.error(`[minecraft-world-owners] could not check ${install.id}:`, caught);
        }
        if (changed === undefined) continue;
        if (changed !== null) fixed += changed;
        await patchInstallConfig(install.id, {
            [WORLD_OWNERS_KEY]: { at: now.toISOString(), ok: changed !== null, fixed: changed ?? 0 }
        }).catch(() => undefined);
    }
    return { checked, fixed };
}
