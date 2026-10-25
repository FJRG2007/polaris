/**
 * An installed app's own releases: what the registry has for it, updating to
 * that without restarting the dashboard, and going back to the build before.
 *
 * The model is a Home Assistant add-on's: every app has a channel of its own
 * (`latest-app-<id>`, tagged in the dashboard's package by the job that moves
 * `latest`), says which dashboards it runs on (its host API, see
 * `@polaris/app-host/version`), and is updated alone from the screen. Nothing
 * here needs the host daemon or the updater, so the limited edition updates its
 * apps the same way.
 *
 * Trust is the image's: the release is read over TLS from the registry the
 * dashboard itself is pulled from, its manifest has to hash to the digest the
 * registry names it by, and the bundle has to hash to the digest and size that
 * manifest names before a byte of it is unpacked. The bundle then has to load
 * - its format, its host API, the libraries it takes - before it replaces the
 * one serving now. Anything short of that leaves the running build in place.
 *
 * Server-only.
 */

import { z } from "zod";
import { join } from "node:path";
import { knownApps } from "./code";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { clearAppFailure } from "./lifecycle";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { loadedBundle, stageBundle, swapBundle, type LoadedBundle } from "./loader";
import { HOST_API, hostApiVerdict } from "@polaris/app-host/version";
import * as store from "./store";
import type { BundlePin } from "./store";

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const ARTIFACT_TYPE = "application/vnd.polaris.app-bundle.v1+zip";

/** An OCI manifest is a few hundred bytes; anything far larger is not one. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const CHECK_TIMEOUT_MS = 15_000;

/** How long a check is reused before the registry is asked again. */
const CHECK_TTL_MS = 10 * 60_000;

/** What the bundler writes on a bundle's OCI manifest (`ociManifest`). */
export const ANNOTATIONS = {
    version: "org.opencontainers.image.version",
    revision: "org.opencontainers.image.revision",
    hostApi: "vnd.polaris.app.host-api",
    notes: "vnd.polaris.app.notes"
} as const;

const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const OciManifest = z.object({
    schemaVersion: z.literal(2),
    mediaType: z.literal(MANIFEST_TYPE).optional(),
    artifactType: z.literal(ARTIFACT_TYPE),
    layers: z
        .array(
            z.object({
                mediaType: z.literal("application/zip"),
                digest: Digest,
                size: z.number().int().positive()
            })
        )
        .length(1),
    annotations: z.record(z.string(), z.string().max(1000)).optional()
});

/** One published build of an app. */
export interface AppRelease {
    readonly digest: string;
    readonly size: number;
    readonly version?: string;
    readonly revision?: string;
    readonly notes?: string;
    readonly hostApi?: string;
}

/** Where an update is, for the screen showing it. */
export interface UpdateProgress {
    readonly phase: "checking" | "downloading" | "starting";
    readonly received: number;
    readonly total: number;
}

/** Why an update or a rollback did not happen, as a code the screen words. */
export type UpdateRefusal =
    "unknown" | "notInstalled" | "busy" | "unreachable" | "needsPolaris" | "failed" | "noPrevious";

export type UpdateOutcome =
    | { readonly ok: true; readonly changed: boolean }
    | { readonly ok: false; readonly code: UpdateRefusal };

type Check = { readonly at: number; readonly release?: AppRelease; readonly failed?: true };
type State = { updating: Map<string, UpdateProgress>; checks: Map<string, Check> };

const state: State = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris.app-bundles.releases")
] ??= { updating: new Map(), checks: new Map() }) as State;

const short = (text: string | undefined, max: number) =>
    text ? text.trim().slice(0, max) || undefined : undefined;

/**
 * A release, from the bytes of its OCI manifest. `named` is the digest the
 * registry answered it under; bytes that hash to anything else are refused.
 */
export function readRelease(bytes: Buffer, named?: string | null): AppRelease {
    if (bytes.length > MAX_MANIFEST_BYTES)
        throw new store.BundleUnavailable("The registry answered something that is not an app.");
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (named && named !== actual) {
        throw new store.BundleUnavailable(
            "The registry answered something other than what it named."
        );
    }
    let json: unknown;
    try {
        json = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new store.BundleUnavailable("The registry answered something that is not an app.");
    }
    const parsed = OciManifest.safeParse(json);
    if (!parsed.success)
        throw new store.BundleUnavailable("The registry answered something that is not an app.");
    // Exactly one, by the schema.
    const layer = parsed.data.layers[0]!;
    const notes = parsed.data.annotations ?? {};
    return {
        digest: layer.digest,
        size: layer.size,
        version: short(notes[ANNOTATIONS.version], 64),
        revision: short(notes[ANNOTATIONS.revision], 64),
        notes: short(notes[ANNOTATIONS.notes], 300),
        hostApi: short(notes[ANNOTATIONS.hostApi], 16)
    };
}

/** A response's body, refused as soon as it runs past `max` bytes. */
async function readBounded(response: Response, max: number): Promise<Buffer> {
    if (!response.body) return Buffer.from(await response.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > max) {
            await reader.cancel().catch(() => undefined);
            throw new store.BundleUnavailable(
                "The registry answered something that is not an app."
            );
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** The newest published build of an app, from its channel in the registry. */
export async function latestRelease(
    id: string,
    { force = false }: { readonly force?: boolean } = {}
): Promise<AppRelease> {
    if (!APP_ID.test(id)) throw new store.BundleUnavailable("That is not an app.");
    const cached = state.checks.get(id);
    if (!force && cached?.release && Date.now() - cached.at < CHECK_TTL_MS) return cached.release;
    const index = store.bundleIndex();
    if (!index)
        throw new store.BundleUnavailable("This version of Polaris was built without apps.");
    const { host, repository } = store.registryOf(index);
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    try {
        const token = await store.pullToken(host, repository, signal);
        const response = await fetch(
            `https://${host}/v2/${repository}/manifests/latest-app-${id}`,
            {
                headers: {
                    accept: MANIFEST_TYPE,
                    ...(token ? { authorization: `Bearer ${token}` } : {})
                },
                signal
            }
        );
        if (!response.ok) throw new store.BundleUnavailable(`${host} answered ${response.status}.`);
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > MAX_MANIFEST_BYTES)
            throw new store.BundleUnavailable(
                "The registry answered something that is not an app."
            );
        const bytes = await readBounded(response, MAX_MANIFEST_BYTES);
        const release = readRelease(bytes, response.headers.get("docker-content-digest"));
        state.checks.set(id, { at: Date.now(), release });
        return release;
    } catch (error) {
        state.checks.set(id, { at: Date.now(), failed: true });
        if (error instanceof store.BundleUnavailable) throw error;
        throw new store.BundleUnavailable(`Polaris could not reach ${host}.`, { cause: error });
    }
}

/**
 * Whether an app that is not running is being brought up by an update now:
 * the one case where a path no loaded app answers may belong to it in a moment.
 */
export function anyAppUpdating(): boolean {
    for (const id of state.updating.keys()) if (!loadedBundle(id)) return true;
    return false;
}

/** Every app being updated or rolled back now, and how far each got. */
export function appsUpdating(): Record<string, UpdateProgress> {
    return Object.fromEntries(state.updating);
}

/** An app being updated or rolled back now, and how far it got. */
export function appUpdating(id: string): UpdateProgress | null {
    return state.updating.get(id) ?? null;
}

function pinOf(release: AppRelease, version?: string): BundlePin {
    return {
        digest: release.digest,
        source: "registry",
        ...(release.version || version ? { version: release.version || version } : {}),
        ...(release.revision ? { revision: release.revision } : {}),
        ...(release.notes ? { notes: release.notes } : {})
    };
}

/** Load a build from its folder in place of the one serving now. */
async function serve(id: string, dir: string): Promise<UpdateOutcome | null> {
    const before = loadedBundle(id);
    let staged: LoadedBundle;
    try {
        staged = await stageBundle(id, dir);
        swapBundle(staged);
        clearAppFailure(id);
    } catch (error) {
        console.error(`polaris: ${id} could not be started from ${dir}:`, error);
        const newer = error instanceof store.BundleIncompatible && error.update === "dashboard";
        return { ok: false, code: newer ? "needsPolaris" : "failed" };
    }
    // An app that was not running had nothing started; one that was keeps
    // what it started (see `swapBundle`). The new build is serving either way,
    // so what its boot work does is its own to report.
    if (!before) {
        try {
            await staged.server.extension.onBoot?.();
        } catch (error) {
            console.error(`polaris: ${id} could not start what it runs from boot:`, error);
        }
    }
    return null;
}

async function guarded(id: string, work: () => Promise<UpdateOutcome>): Promise<UpdateOutcome> {
    if (!APP_ID.test(id) || !knownApps().includes(id)) return { ok: false, code: "unknown" };
    if (!(await isAppInstalled(id).catch(() => false))) return { ok: false, code: "notInstalled" };
    if (state.updating.has(id)) return { ok: false, code: "busy" };
    state.updating.set(id, { phase: "checking", received: 0, total: 0 });
    try {
        return await work();
    } catch (error) {
        console.error(`polaris: ${id} could not be updated:`, error);
        return { ok: false, code: "failed" };
    } finally {
        state.updating.delete(id);
    }
}

/**
 * Update one app to the newest build published for it, without a restart.
 * When anything fails - the registry, the store.download, the check, the bundle
 * starting - the build serving now keeps serving and nothing is recorded.
 */
export function updateApp(id: string): Promise<UpdateOutcome> {
    return guarded(id, async () => {
        let release: AppRelease;
        try {
            release = await latestRelease(id, { force: true });
        } catch (error) {
            console.error(`polaris: ${id}'s releases could not be read:`, error);
            return { ok: false, code: "unreachable" };
        }
        const pinned = await store.readBundleState(id);
        if (pinned?.current.digest === release.digest && loadedBundle(id)) {
            return { ok: true, changed: false };
        }
        const verdict = hostApiVerdict(release.hostApi, HOST_API);
        if (!verdict.ok)
            return { ok: false, code: verdict.update === "dashboard" ? "needsPolaris" : "failed" };

        const index = store.bundleIndex();
        if (!index) return { ok: false, code: "unknown" };
        const target = store.bundleDir(id, release.digest);
        let fresh = false;
        if (!existsSync(join(target, "manifest.json"))) {
            let bytes: Buffer;
            try {
                state.updating.set(id, { phase: "downloading", received: 0, total: release.size });
                bytes = await store.download(index, release, (received, total) =>
                    state.updating.set(id, { phase: "downloading", received, total })
                );
            } catch (error) {
                console.error(`polaris: ${id} could not be downloaded:`, error);
                return { ok: false, code: "unreachable" };
            }
            store.verify(bytes, release);
            await mkdir(join(store.bundleRoot(), id), { recursive: true });
            await store.unpack(bytes, id, target);
            fresh = true;
        }
        state.updating.set(id, { phase: "starting", received: release.size, total: release.size });
        const refused = await serve(id, target);
        if (refused) {
            if (fresh) await rm(target, { recursive: true, force: true }).catch(() => undefined);
            return refused;
        }
        const manifest = await store.readManifest(target).catch(() => null);
        const previous =
            pinned && pinned.current.digest !== release.digest
                ? pinned.current
                : (pinned?.previous ?? null);
        await store.writeBundleState(id, {
            current: pinOf(release, manifest?.version),
            previous,
            image: pinned?.image ?? index.apps[id]?.digest ?? null
        });
        void store.dropOthers(id).catch(() => undefined);
        return { ok: true, changed: true };
    });
}

/** Go back to the build an app ran before its last update, without a restart. */
export function rollbackApp(id: string): Promise<UpdateOutcome> {
    return guarded(id, async () => {
        const pinned = await store.readBundleState(id);
        const previous = pinned?.previous;
        if (!pinned || !previous) return { ok: false, code: "noPrevious" };
        const dir = store.bundleDir(id, previous.digest);
        if (!existsSync(join(dir, "manifest.json"))) return { ok: false, code: "noPrevious" };
        state.updating.set(id, { phase: "starting", received: 0, total: 0 });
        const refused = await serve(id, dir);
        if (refused) return refused;
        await store.writeBundleState(id, {
            current: previous,
            previous: pinned.current,
            image: pinned.image
        });
        return { ok: true, changed: true };
    });
}

/** One installed app, as the updates screen shows it. */
export interface AppReleaseStatus {
    readonly id: string;
    readonly running: boolean;
    readonly installed: BundlePin | null;
    readonly previous: BundlePin | null;
    readonly available: (AppRelease & { readonly runs: boolean }) | null;
    /** The release could not be read: the registry did not answer, or answered badly. */
    readonly checkFailed: boolean;
    readonly progress: UpdateProgress | null;
}

/**
 * Every installed app's build and the newest one published for it. `check`
 * asks the registry, reusing an answer from the last ten minutes.
 */
export async function appReleaseStatuses({
    check = true
}: { readonly check?: boolean } = {}): Promise<AppReleaseStatus[]> {
    const ids: string[] = [];
    for (const id of knownApps()) if (await isAppInstalled(id).catch(() => false)) ids.push(id);
    return Promise.all(
        ids.map(async (id): Promise<AppReleaseStatus> => {
            const [pinned, release] = await Promise.all([
                store.readBundleState(id),
                check
                    ? latestRelease(id).catch(() => null)
                    : Promise.resolve(state.checks.get(id)?.release ?? null)
            ]);
            const loaded = loadedBundle(id);
            const installed =
                pinned?.current ??
                (loaded
                    ? {
                          digest: `sha256:${loaded.version}`,
                          source: "image" as const,
                          ...(loaded.manifest.version ? { version: loaded.manifest.version } : {})
                      }
                    : null);
            const previous =
                pinned?.previous &&
                existsSync(join(store.bundleDir(id, pinned.previous.digest), "manifest.json"))
                    ? pinned.previous
                    : null;
            return {
                id,
                running: Boolean(loaded),
                installed,
                previous,
                available: release
                    ? { ...release, runs: hostApiVerdict(release.hostApi, HOST_API).ok }
                    : null,
                checkFailed: check && !release,
                progress: appUpdating(id)
            };
        })
    );
}
