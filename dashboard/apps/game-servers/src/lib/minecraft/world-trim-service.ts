/**
 * Running the world optimizer.
 *
 * The decisions are in `world-trim`; this is what reaches the container. Three
 * things happen here that do not happen there, and each of them is a rule rather
 * than a step:
 *
 * The server has to be down. Not "should be" - the machine refuses otherwise, and
 * this asks it to. A running Minecraft server holds every region file open and
 * remembers where each chunk sits inside it, so a file rewritten underneath it is
 * one the server then writes back through a table that no longer describes it.
 *
 * A backup is taken first, every time, by the script itself once the server is
 * down: it copies the world beside itself, reads the copy back in full, and
 * refuses to rewrite anything unless the copy holds every file about to change.
 * Its name comes back in the report, recorded with the run, so the screen can
 * offer to put it back. There is no way to ask for a run without one.
 *
 * And the server goes back to whatever it was. A server that was running is
 * running again at the end, including when the optimizer failed; a server that
 * was already stopped is left stopped, because starting somebody's server for
 * them is not part of tidying up a world.
 *
 * The volume is held for the run (`lib/storage-moves/hold`), so a storage move
 * cannot copy it mid-rewrite or empty the original out from under this job.
 */

import { gameMessage } from "../game-message";
import { prisma } from "@polaris/db";
import { DATA_DIR, levelParent } from "./world";
import { withServerContainer } from "./service";
import { WORLD_TRIM_SCRIPT } from "./world-trim-script";
import {
    describeTrim,
    readTrimReport,
    readWorldTrim,
    readWorldTrimRun,
    trimDue,
    WORLD_TRIM_RUN_KEY,
    type WorldTrimReport,
    type WorldTrimSettings
} from "./world-trim";
import { host } from "@polaris/app-host";

const { setApplicationRunning } = host.deployService;
const { holdStorage, releaseStorage } = host.storageHold;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/** What an attempt did, for the screen that asked and for the record. */
export interface WorldTrimOutcome {
    readonly report: WorldTrimReport | null;
    /** Null when it worked. A sentence when it did not, in words the person who
     *  pressed the button can act on. */
    readonly failure: string | null;
    /** Whether the server was stopped and started again to do this. */
    readonly restarted: boolean;
}

/** The level this server is on, and so the folder the optimizer is pointed at. */
async function worldPathOf(ownerId: string, installedAppId: string): Promise<string> {
    const { listEnvVars } = host.envVarService;
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { applicationId: true, catalogId: true }
    });
    if (!install?.applicationId) throw new Error(gameMessage("games", "lib.notDeployed"));
    const env = await listEnvVars("application", install.applicationId, ownerId).catch(() => []);
    const level = env.find((row: { key: string }) => row.key === "LEVEL")?.value?.trim();
    // The image defaults to a level called `world`, and a level name with a slash
    // or a parent step in it is not a level name - it is somebody pointing this at
    // a folder outside the world.
    const name =
        level && /^[A-Za-z0-9 _.-]{1,64}$/.test(level) && !level.includes("..") ? level : "world";
    return `${levelParent("java")}/${name}`;
}

/**
 * Measure what an optimization would do, without changing anything.
 *
 * Runs the same script the real one does, with the same rules, so the figure on
 * the screen is the figure that will happen rather than an estimate of it. Still
 * needs the server stopped: reading a region file a live server is writing would
 * give a number that was true for a moment.
 */
export async function previewWorldTrim(
    ownerId: string,
    installedAppId: string
): Promise<WorldTrimOutcome> {
    return runTrim(ownerId, installedAppId, { dryRun: true, restart: false, trigger: "button" });
}

/**
 * Optimize the world now, stopping the server for it if it is up.
 *
 * The button behind the screen. Throws nothing: everything that can go wrong here
 * is something the person watching is owed a sentence about.
 */
export async function optimizeWorldNow(
    ownerId: string,
    installedAppId: string
): Promise<WorldTrimOutcome> {
    // No option to skip the backup: the script itself copies the world, reads
    // the copy back and refuses to rewrite anything without it (BUG-0009).
    return runTrim(ownerId, installedAppId, { dryRun: false, restart: true, trigger: "button" });
}

/**
 * Do it on Polaris's own initiative, for a server that is already stopped.
 *
 * Never starts or stops anything: see `trimDue`. A server that is down for its
 * own reasons is a free moment, and this is the only kind of moment an automatic
 * optimization is allowed to use.
 */
export async function sweepWorldTrim(
    ownerId: string,
    installedAppId: string,
    now = new Date()
): Promise<boolean> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { config: true, catalogId: true, applicationId: true }
    });
    if (!install?.applicationId) return false;
    const config = readInstallConfig(install.config);
    const app = await prisma.application
        .findUnique({ where: { id: install.applicationId }, select: { desiredState: true } })
        .catch(() => null);
    const edition = install.catalogId === "minecraft" ? "java" : "bedrock";
    if (
        !trimDue(readWorldTrim(config), readWorldTrimRun(config), now, {
            running: app?.desiredState === "running",
            edition
        })
    )
        return false;
    // Unreachable while AUTOMATIC_TRIM_DISABLED holds (see `trimDue`). Were it
    // ever reached, the script still backs up and refuses exactly as it does for
    // the button.
    const outcome = await runTrim(ownerId, installedAppId, {
        dryRun: false,
        restart: false,
        trigger: "automatic"
    });
    return outcome.failure === null;
}

async function runTrim(
    ownerId: string,
    installedAppId: string,
    how: { dryRun: boolean; restart: boolean; trigger: "button" | "automatic" }
): Promise<WorldTrimOutcome> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true, config: true }
    });
    if (!install?.applicationId) return fail(gameMessage("games", "lib.notDeployed"), false);
    if (install.catalogId !== "minecraft")
        return fail(gameMessage("games", "lib.trim.javaOnly"), false);

    const settings = readWorldTrim(readInstallConfig(install.config));
    const world = await worldPathOf(ownerId, installedAppId).catch(() => `${DATA_DIR}/world`);
    const app = await prisma.application
        .findUnique({ where: { id: install.applicationId }, select: { desiredState: true } })
        .catch(() => null);
    const wasRunning = app?.desiredState === "running";

    if (wasRunning && !how.restart) return fail(gameMessage("games", "lib.trim.stopFirst"), false);

    let restarted = false;
    const held = [install.applicationId];
    await holdStorage(held);
    try {
        if (wasRunning) {
            await setApplicationRunning(install.applicationId, ownerId, false);
            restarted = true;
        }
        const outcome = await execute(ownerId, installedAppId, world, settings, how.dryRun);
        if (!how.dryRun) await record(installedAppId, outcome, how.trigger);
        return { ...outcome, restarted };
    } catch (caught) {
        const why =
            caught instanceof Error ? caught.message : gameMessage("games", "lib.trim.failed");
        if (!how.dryRun)
            await record(installedAppId, { report: null, failure: why, restarted }, how.trigger);
        return { report: null, failure: why, restarted };
    } finally {
        // Always, including after a failure: a server that was up when somebody
        // pressed this has to be up when they look again.
        await releaseStorage(held).catch(() => undefined);
        if (restarted)
            await setApplicationRunning(install.applicationId, ownerId, true).catch(
                () => undefined
            );
    }
}

async function execute(
    ownerId: string,
    installedAppId: string,
    world: string,
    settings: WorldTrimSettings,
    dryRun: boolean
): Promise<WorldTrimOutcome> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.trimWorld) return fail(gameMessage("games", "lib.trim.needsNewer"), false);
        const result = await server.trimWorld(WORLD_TRIM_SCRIPT, {
            world,
            keepTicks: settings.keepTicks,
            keepRadius: settings.keepRadius,
            dryRun
        });
        const report = readTrimReport(result.output);
        // A rewrite with no backup in the report is not something this script
        // does; anything that claims one is not to be reported as a success.
        if (report && !dryRun && !report.refused && report.removed > 0 && !report.backup)
            return fail(gameMessage("games", "lib.trim.failed"), false);
        if (result.code !== 0 || !report) {
            // The container's own words, when it said anything worth repeating.
            // "python3: not found" is the whole answer for an image that has none,
            // and inventing a friendlier sentence would hide it.
            const said = result.output.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
            return fail(
                said.length > 0 && said.length < 300
                    ? said
                    : gameMessage("games", "lib.trim.failed"),
                false
            );
        }
        return { report, failure: null, restarted: false };
    });
}

/** Write down what happened, so the screen can say it and the sweep knows this
 *  world has been done. A failure is recorded too: a run that keeps failing is
 *  worth seeing, and it stops the sweep trying again every minute. */
async function record(
    installedAppId: string,
    outcome: WorldTrimOutcome,
    trigger: "button" | "automatic"
): Promise<void> {
    const refused = outcome.report?.refused ?? null;
    await patchInstallConfig(installedAppId, {
        [WORLD_TRIM_RUN_KEY]: {
            at: new Date().toISOString(),
            ok: outcome.failure === null && refused === null,
            removed: refused ? 0 : (outcome.report?.removed ?? 0),
            freedBytes: refused ? 0 : (outcome.report?.freedBytes ?? 0),
            detail: outcome.failure ?? (outcome.report ? describeTrim(outcome.report) : ""),
            trigger,
            backup: outcome.report?.backup?.name ?? null
        }
    }).catch(() => undefined);
}

function fail(why: string, restarted: boolean): WorldTrimOutcome {
    return { report: null, failure: why, restarted };
}
