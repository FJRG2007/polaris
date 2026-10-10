/**
 * Holding a server's mod loader at the version it installed, and letting it go
 * again on purpose. The rules are in `loader-pin.ts`; this reads the server's
 * manifest and writes its variables.
 *
 * Three ways in:
 *
 * - The health sweep, once a minute, for a server still following the newest
 *   loader. That is how every existing server gets held without anybody doing
 *   anything, and how a new one is: the image resolves the newest loader on its
 *   first start, and what it installed is held from then on.
 * - The crash-loop guard, for a server that could not download its loader: the
 *   version on disk is held so pressing Start runs it without asking anybody.
 * - The settings card, which shows the held version and can let it go once.
 *
 * A variable written here reaches the container the next time Polaris starts it
 * (Start, a settings save, a restart). A restart the engine does by itself
 * keeps the variables the container was created with.
 */

import * as pin from "./loader-pin";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { reachedReady } from "../crash-loop";
import { gameOfServer } from "@polaris/core";
import { editionOf, withServerContainer } from "./service";
import { readContainerBytes } from "../container-files";
import { fetchLoaderVersions } from "./loader-versions";

const { listEnvVars, setEnvVars } = host.envVarService;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { readAppContainerRuntime } = host.appContainerMetrics;
const { readAppRuntimeLog } = host.deployService;

/** Where an install keeps what this has tried and what it let go of. */
export const LOADER_PIN_KEY = "loaderPin";

/** How long a server whose manifest could not be read is left before the sweep
 *  reads it again. Every minute would be an exec a minute into a server that
 *  has nothing to say. */
const RETRY_MS = 30 * 60 * 1000;

/** How long after "Update loader" the old version is not taken back, for a server
 *  whose container this side cannot inspect: long enough for the update's own
 *  start to install the new one and write its manifest. */
const UPDATE_GRACE_MS = 30 * 60 * 1000;

/** A run older than this has long finished installing its loader, even when its
 *  ready line has scrolled out of the log tail. */
const SETTLED_RUN_MS = 15 * 60 * 1000;

/** How much log decides whether the current run got as far as the game. */
const READY_TAIL = 200;

interface PinRecord {
    /** When reading the manifest last failed. */
    readonly triedAt: string | null;
    /** The version "Update loader" let go of, and when. */
    readonly updating: { readonly from: string; readonly at: string } | null;
}

function pinRecordOf(config: string | null): PinRecord {
    const value = readInstallConfig(config)[LOADER_PIN_KEY];
    if (typeof value !== "object" || value === null) return { triedAt: null, updating: null };
    const record = value as Record<string, unknown>;
    const updating = record.updating as Record<string, unknown> | undefined;
    return {
        triedAt: typeof record.triedAt === "string" ? record.triedAt : null,
        updating:
            updating && typeof updating.from === "string" && typeof updating.at === "string"
                ? { from: updating.from, at: updating.at }
                : null
    };
}

function sinceMs(iso: string | null, now: Date): number {
    const at = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now.getTime() - at;
}

async function installOf(ownerId: string, installedAppId: string) {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { id: true, applicationId: true, config: true }
    });
    return install?.applicationId ? { ...install, applicationId: install.applicationId } : null;
}

/**
 * Whether the update somebody asked for is still waiting for a start: the
 * container has not started since it was asked for. A stopped server keeps it
 * waiting for as long as it stays stopped, rather than having it taken back on
 * a timer before it ever ran. Only a container this side cannot inspect falls
 * back to the timer.
 */
async function updatePending(
    updating: PinRecord["updating"],
    applicationId: string,
    ownerId: string,
    now: Date
): Promise<boolean> {
    if (!updating) return false;
    const state = await readAppContainerRuntime(applicationId, ownerId).catch(() => null);
    if (!state) return sinceMs(updating.at, now) < UPDATE_GRACE_MS;
    const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
    if (Number.isNaN(started) || started <= 0) return true;
    return started <= Date.parse(updating.at);
}

async function envOf(applicationId: string, ownerId: string): Promise<(key: string) => string> {
    const rows = await listEnvVars("application", applicationId, ownerId);
    const values: Record<string, string> = {};
    for (const row of rows) if (row.value !== null) values[row.key] = row.value;
    return pin.envReader(values);
}

/** What the settings card shows: the loader's state, and whether an update is
 *  waiting for the server's next start to install it. */
export interface LoaderPinView {
    readonly pin: pin.LoaderPinState;
    readonly updating: boolean;
}

export async function readLoaderPin(
    ownerId: string,
    installedAppId: string,
    now: Date = new Date()
): Promise<LoaderPinView | null> {
    const install = await installOf(ownerId, installedAppId);
    if (!install) return null;
    const env = await envOf(install.applicationId, ownerId);
    const record = pinRecordOf(install.config);
    return {
        pin: pin.loaderPinState(env),
        updating: await updatePending(record.updating, install.applicationId, ownerId, now)
    };
}

export type PinOutcome =
    | { readonly state: "pinned"; readonly loader: string; readonly version: string }
    /** Held at a version somebody set; `installed` when the manifest on disk
     *  names that same version, so a start runs it without downloading. */
    | {
          readonly state: "held";
          readonly loader: string;
          readonly version: string;
          readonly installed: boolean;
      }
    /** Nothing to hold it at: not a loader, a channel rather than a release, a
     *  loader of somebody's own, or no manifest for this release on disk. */
    | {
          readonly state: "unavailable";
          readonly reason: "none" | "release" | "custom" | "manifest";
      };

/**
 * Hold this server at the loader its manifest says is installed.
 *
 * Read through the daemon's file route, which serves a stopped container from
 * its volumes - a server that just crash-looped is exactly the one that is
 * down. Idempotent: a server already held reports the version it is held at.
 */
export async function pinInstalledLoader(
    ownerId: string,
    installedAppId: string,
    now: Date = new Date()
): Promise<PinOutcome> {
    const install = await installOf(ownerId, installedAppId);
    if (!install) return { state: "unavailable", reason: "none" };
    const env = await envOf(install.applicationId, ownerId);
    const state = pin.loaderPinState(env);
    if (state.state === "held") {
        const spec = pin.loaderSpecOf(env("TYPE"));
        const manifest = spec ? await readManifest(ownerId, installedAppId, spec) : null;
        const installed = manifest ? pin.installedFromManifest(env, manifest) : null;
        return {
            state: "held",
            loader: state.loader,
            version: state.version,
            installed: installed === state.version.trim()
        };
    }
    if (state.state !== "following") {
        return { state: "unavailable", reason: state.state === "none" ? "none" : state.state };
    }
    const spec = pin.loaderToPin(env);
    if (!spec) return { state: "unavailable", reason: "none" };
    const manifest = await readManifest(ownerId, installedAppId, spec);
    const found = manifest ? pin.pinFromManifest(env, manifest) : null;
    const record = pinRecordOf(install.config);
    // The update somebody asked for has not installed yet: the manifest still
    // names the version they let go of, and holding it would undo the update.
    const stale =
        found !== null &&
        record.updating?.from === found.version &&
        (await updatePending(record.updating, install.applicationId, ownerId, now));
    if (!found || stale) {
        await patchInstallConfig(install.id, {
            [LOADER_PIN_KEY]: { triedAt: now.toISOString(), updating: record.updating }
        }).catch(() => undefined);
        return { state: "unavailable", reason: "manifest" };
    }
    await setEnvVars(
        "application",
        install.applicationId,
        ownerId,
        Object.entries(found.vars).map(([key, value]) => ({ key, value, isSecret: false }))
    );
    await patchInstallConfig(install.id, { [LOADER_PIN_KEY]: null }).catch(() => undefined);
    return { state: "pinned", loader: found.loader, version: found.version };
}

/** The manifest the loader's installer wrote, read off the server's volumes. */
async function readManifest(
    ownerId: string,
    installedAppId: string,
    spec: NonNullable<ReturnType<typeof pin.loaderSpecOf>>
): Promise<string | null> {
    const bytes = await withServerContainer(ownerId, installedAppId, (server) =>
        readContainerBytes(server, pin.manifestPath(spec))
    ).catch(() => null);
    return bytes ? bytes.toString("utf8") : null;
}

/**
 * Let the held loader go, once: the next start installs the newest one, and the
 * sweep holds that from then on. The caller restarts the server.
 */
export async function releaseLoaderOnce(
    ownerId: string,
    installedAppId: string,
    now: Date = new Date()
): Promise<{ readonly from: string } | null> {
    const install = await installOf(ownerId, installedAppId);
    if (!install) return null;
    const env = await envOf(install.applicationId, ownerId);
    const state = pin.loaderPinState(env);
    if (state.state !== "held") return null;
    // Empty rather than removed: the image reads an empty variable as unset
    // (`${NEOFORGE_VERSION:=latest}`), and the variable stays visible as the
    // loader's setting.
    await setEnvVars(
        "application",
        install.applicationId,
        ownerId,
        pin.unpinVars(env).map((key) => ({ key, value: "", isSecret: false }))
    );
    await patchInstallConfig(install.id, {
        [LOADER_PIN_KEY]: {
            triedAt: null,
            updating: { from: state.version, at: now.toISOString() }
        }
    });
    return { from: state.version };
}

/** The loader versions a server can be moved to, for the card's picker. */
export interface LoaderVersions {
    readonly loader: string;
    readonly minecraft: string;
    /** Newest first. Empty when the repository could not be read. */
    readonly versions: readonly string[];
}

/** What this server's loader can be set to, or null when there is no choice to
 *  make (see `loaderChoiceOf`). */
export async function loaderVersionsFor(
    ownerId: string,
    installedAppId: string
): Promise<LoaderVersions | null> {
    const install = await installOf(ownerId, installedAppId);
    if (!install) return null;
    const choice = pin.loaderChoiceOf(await envOf(install.applicationId, ownerId));
    if (!choice) return null;
    return {
        loader: choice.loader,
        minecraft: choice.minecraft,
        versions: await fetchLoaderVersions(choice.type, choice.minecraft)
    };
}

export type LoaderChoice =
    | { readonly state: "chosen"; readonly loader: string; readonly from: string | null }
    /** Nothing to choose on this server, or not a version its repository lists
     *  for the release. */
    | { readonly state: "refused"; readonly reason: "none" | "unknown" };

/**
 * Hold the server at a loader version somebody picked. The caller restarts it.
 *
 * Only a version the loader's own repository lists for the server's release is
 * written: anything else is a server that asks for a build that does not exist
 * and never starts. An update that was waiting is called off - this is the
 * newer decision.
 */
export async function chooseLoaderVersion(
    ownerId: string,
    installedAppId: string,
    version: string
): Promise<LoaderChoice> {
    const install = await installOf(ownerId, installedAppId);
    if (!install) return { state: "refused", reason: "none" };
    const env = await envOf(install.applicationId, ownerId);
    const choice = pin.loaderChoiceOf(env);
    if (!choice) return { state: "refused", reason: "none" };
    const listed = await fetchLoaderVersions(choice.type, choice.minecraft);
    const vars = listed.includes(version.trim()) ? pin.chosenLoaderVars(env, version) : null;
    if (!vars) return { state: "refused", reason: "unknown" };
    const state = pin.loaderPinState(env);
    await setEnvVars(
        "application",
        install.applicationId,
        ownerId,
        Object.entries(vars).map(([key, value]) => ({ key, value, isSecret: false }))
    );
    await patchInstallConfig(install.id, { [LOADER_PIN_KEY]: null }).catch(() => undefined);
    return {
        state: "chosen",
        loader: choice.loader,
        from: state.state === "held" ? state.version : null
    };
}

/**
 * Whether the run the server is on has finished installing its loader, so its
 * manifest is what it runs. A container that is not up is settled - nothing is
 * installing - and one this side cannot inspect (another machine) is taken as
 * settled too, since the manifest still has to name the server's own release.
 */
async function runSettled(applicationId: string, ownerId: string, now: Date): Promise<boolean> {
    const state = await readAppContainerRuntime(applicationId, ownerId).catch(() => null);
    if (!state || state.status !== "running") return true;
    if (state.restarting === true) return false;
    if (sinceMs(state.startedAt ?? null, now) >= SETTLED_RUN_MS) return true;
    const log = await readAppRuntimeLog(applicationId, ownerId, READY_TAIL).catch(() => "");
    return reachedReady(log);
}

export interface LoaderPinSweep {
    readonly checked: number;
    readonly pinned: number;
}

/**
 * Hold every server of this owner that is still following the newest loader.
 *
 * Bounded: one query for the installs and one for the variables that decide it,
 * and a file read only for a server that is following, has a release named, and
 * has not failed a read in the last half hour. Once held, a server costs this
 * nothing again.
 */
export async function sweepLoaderPins(
    ownerId: string,
    now: Date = new Date()
): Promise<LoaderPinSweep> {
    const installs = (
        await prisma.installedApp.findMany({
            where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
            select: { id: true, applicationId: true, catalogId: true, config: true }
        })
    ).filter(
        (install) =>
            gameOfServer(install.catalogId)?.id === "minecraft" &&
            editionOf(install.catalogId) === "java"
    );
    const ids = installs.flatMap((install) =>
        install.applicationId ? [install.applicationId] : []
    );
    if (ids.length === 0) return { checked: 0, pinned: 0 };
    const rows = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: { in: ids },
            key: { in: [...pin.LOADER_ENV_KEYS] },
            isSecret: false
        },
        select: { scopeId: true, key: true, value: true }
    });
    const envs = new Map<string, Record<string, string>>();
    for (const row of rows) {
        const env = envs.get(row.scopeId) ?? {};
        env[row.key] = row.value ?? "";
        envs.set(row.scopeId, env);
    }

    let checked = 0;
    let pinned = 0;
    for (const install of installs) {
        const env = install.applicationId ? envs.get(install.applicationId) : undefined;
        if (!install.applicationId || !env || !pin.loaderToPin(pin.envReader(env))) continue;
        if (sinceMs(pinRecordOf(install.config).triedAt, now) < RETRY_MS) continue;
        checked += 1;
        if (!(await runSettled(install.applicationId, ownerId, now))) continue;
        const outcome = await pinInstalledLoader(ownerId, install.id, now).catch(() => null);
        if (outcome?.state === "pinned") pinned += 1;
    }
    return { checked, pinned };
}
