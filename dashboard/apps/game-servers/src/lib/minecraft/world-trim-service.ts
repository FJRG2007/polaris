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
 * A backup is taken first, and it is taken while the server is still up, because
 * that is the only time the archive can be made - it is the container's own `tar`.
 * So the order is: back up, stop, optimize, start. An automatic run that cannot
 * take a backup does not run at all.
 *
 * And the server goes back to whatever it was. A server that was running is
 * running again at the end, including when the optimizer failed; a server that
 * was already stopped is left stopped, because starting somebody's server for
 * them is not part of tidying up a world.
 */

import { prisma } from "@polaris/db";
import { DATA_DIR, levelParent } from "./world";
import { withServerContainer } from "./service";
import { createWorldBackup } from "./world-service";
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
    if (!install?.applicationId) throw new Error("This server has not been deployed yet");
    const env = await listEnvVars("application", install.applicationId, ownerId).catch(() => []);
    const level = env.find((row: { key: string }) => row.key === "LEVEL")?.value?.trim();
    // The image defaults to a level called `world`, and a level name with a slash
    // or a parent step in it is not a level name - it is somebody pointing this at
    // a folder outside the world.
    const name = level && /^[A-Za-z0-9 _.-]{1,64}$/.test(level) && !level.includes("..") ? level : "world";
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
export async function previewWorldTrim(ownerId: string, installedAppId: string): Promise<WorldTrimOutcome> {
    return runTrim(ownerId, installedAppId, { dryRun: true, backup: false, restart: false });
}

/**
 * Optimize the world now, stopping the server for it if it is up.
 *
 * The button behind the screen. Throws nothing: everything that can go wrong here
 * is something the person watching is owed a sentence about.
 */
export async function optimizeWorldNow(
    ownerId: string,
    installedAppId: string,
    options: { backup?: boolean } = {}
): Promise<WorldTrimOutcome> {
    return runTrim(ownerId, installedAppId, {
        dryRun: false,
        backup: options.backup !== false,
        restart: true
    });
}

/**
 * Do it on Polaris's own initiative, for a server that is already stopped.
 *
 * Never starts or stops anything: see `trimDue`. A server that is down for its
 * own reasons is a free moment, and this is the only kind of moment an automatic
 * optimization is allowed to use.
 */
export async function sweepWorldTrim(ownerId: string, installedAppId: string, now = new Date()): Promise<boolean> {
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
    // No backup: the archive is made by the container's own tar, which needs the
    // server up, and starting it to back it up would be the sweep stopping and
    // starting a server nobody asked it to touch. A stopped server's world is
    // already covered by whatever backup plan it has.
    const outcome = await runTrim(ownerId, installedAppId, { dryRun: false, backup: false, restart: false });
    return outcome.failure === null;
}

async function runTrim(
    ownerId: string,
    installedAppId: string,
    how: { dryRun: boolean; backup: boolean; restart: boolean }
): Promise<WorldTrimOutcome> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { applicationId: true, catalogId: true, config: true }
    });
    if (!install?.applicationId) return fail("This server has not been deployed yet", false);
    if (install.catalogId !== "minecraft")
        return fail("Only a Java server keeps its world in the files this reads", false);

    const settings = readWorldTrim(readInstallConfig(install.config));
    const world = await worldPathOf(ownerId, installedAppId).catch(() => `${DATA_DIR}/world`);
    const app = await prisma.application
        .findUnique({ where: { id: install.applicationId }, select: { desiredState: true } })
        .catch(() => null);
    const wasRunning = app?.desiredState === "running";

    if (wasRunning && !how.restart)
        return fail("The server has to be stopped before its world can be optimized", false);

    let restarted = false;
    try {
        if (how.backup) {
            // Before the stop, because the archive is the container's own tar.
            await createWorldBackup(ownerId, installedAppId);
        }
        if (wasRunning) {
            await setApplicationRunning(install.applicationId, ownerId, false);
            restarted = true;
        }
        const outcome = await execute(ownerId, installedAppId, world, settings, how.dryRun);
        if (!how.dryRun) await record(installedAppId, outcome);
        return { ...outcome, restarted };
    } catch (caught) {
        const why = caught instanceof Error ? caught.message : "The world could not be optimized";
        if (!how.dryRun) await record(installedAppId, { report: null, failure: why, restarted });
        return { report: null, failure: why, restarted };
    } finally {
        // Always, including after a failure: a server that was up when somebody
        // pressed this has to be up when they look again.
        if (restarted) await setApplicationRunning(install.applicationId, ownerId, true).catch(() => undefined);
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
        if (!server.trimWorld)
            return fail("This machine needs a newer Polaris before it can optimize a world", false);
        const result = await server.trimWorld(WORLD_TRIM_SCRIPT, {
            world,
            keepTicks: settings.keepTicks,
            keepRadius: settings.keepRadius,
            dryRun
        });
        const report = readTrimReport(result.output);
        if (result.code !== 0 || !report) {
            // The container's own words, when it said anything worth repeating.
            // "python3: not found" is the whole answer for an image that has none,
            // and inventing a friendlier sentence would hide it.
            const said = result.output.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
            return fail(said.length > 0 && said.length < 300 ? said : "The world could not be optimized", false);
        }
        return { report, failure: null, restarted: false };
    });
}

/** Write down what happened, so the screen can say it and the sweep knows this
 *  world has been done. A failure is recorded too: a run that keeps failing is
 *  worth seeing, and it stops the sweep trying again every minute. */
async function record(installedAppId: string, outcome: WorldTrimOutcome): Promise<void> {
    await patchInstallConfig(installedAppId, {
        [WORLD_TRIM_RUN_KEY]: {
            at: new Date().toISOString(),
            ok: outcome.failure === null,
            removed: outcome.report?.removed ?? 0,
            freedBytes: outcome.report?.freedBytes ?? 0,
            detail: outcome.failure ?? (outcome.report ? describeTrim(outcome.report) : "")
        }
    }).catch(() => undefined);
}

function fail(why: string, restarted: boolean): WorldTrimOutcome {
    return { report: null, failure: why, restarted };
}
