/**
 * Where an installed app's bundle comes from, and where it is kept.
 *
 * The image says which bundle belongs to it: CI builds every app against the
 * same commit as the dashboard and writes each bundle's digest into the image
 * (`app-bundles/index.json`). So the digest is not something this server is
 * told by the registry - it is part of the image the operator already chose to
 * run, and a downloaded bundle that hashes to anything else is refused. That is
 * also what keeps a dashboard from ever running an app built for another one.
 *
 * The bundle itself is fetched from the registry the image came from, by that
 * digest, and unpacked onto the data volume every install already has, one
 * folder per app. An image built on this host carries its bundles inside it
 * instead, since nothing published them; they are read from there the same way.
 *
 * Server-only.
 */

import JSZip from "jszip";
import { z } from "zod";
import { createHash } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { afterPredecessor } from "@/lib/deploy/dashboard-peers";
import { dirname, join, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";

/** The bundle format this dashboard loads (see the bundler's BUNDLE_FORMAT). */
export const BUNDLE_FORMAT = 1;

/** Larger than any app is, small enough that a wrong answer cannot fill a disk. */
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 120_000;

const DIGEST = /^sha256:([a-f0-9]{64})$/;

/** A file inside a bundle: relative, no `..`, nothing a path could escape with. */
const ENTRY = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@()[\]/-]+$/;

export interface BundleRef {
    readonly file: string;
    readonly digest: string;
    readonly size: number;
}

export interface BundleIndex {
    readonly format: number;
    readonly build: string;
    /** Where the bundles were published, as `<host>/<repository>`. */
    readonly registry?: string;
    readonly apps: Readonly<Record<string, BundleRef>>;
}

export interface BundleManifest {
    readonly format: number;
    readonly id: string;
    readonly build: string;
    /** The app's own version, from its package.json. */
    readonly version?: string;
    /** The host API it needs (`@polaris/app-host/version`); absent on a bundle
     *  built before bundles declared one. */
    readonly hostApi?: string;
    readonly server: string;
    readonly routes: readonly string[];
    readonly actions: Readonly<Record<string, readonly string[]>>;
    readonly client: Readonly<
        Record<string, { readonly file: string; readonly exports: readonly string[] }>
    >;
    readonly shared: { readonly server: readonly string[]; readonly client: readonly string[] };
    /** The client component that draws the app's slots in core screens. */
    readonly slot?: { readonly module: string; readonly name: string };
}

/** Why a bundle could not be had, in words for the screen that asked. */
export class BundleUnavailable extends Error {}

/**
 * A bundle that is here but cannot run on this dashboard: built for a newer
 * one, or for an older host API this one no longer provides. `update` names the
 * side that has to move - never a crash, never a blank page.
 */
export class BundleIncompatible extends BundleUnavailable {
    constructor(
        message: string,
        readonly update: "dashboard" | "app"
    ) {
        super(message);
    }
}

/** Where the image keeps its index, and its bundles when it was built here. */
export function imageBundleDir(): string {
    return process.env.POLARIS_APP_BUNDLES_DIR || "/app/app-bundles";
}

/** Where unpacked bundles live: on the data volume, which survives an update. */
export function bundleRoot(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "apps");
}

let indexCache: BundleIndex | null | undefined;

/** The image's own list of bundles, or null for a dashboard built without one. */
export function bundleIndex(): BundleIndex | null {
    if (indexCache !== undefined) return indexCache;
    const path = join(imageBundleDir(), "index.json");
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as BundleIndex;
        indexCache = parsed.format === BUNDLE_FORMAT && parsed.apps ? parsed : null;
    } catch {
        indexCache = null;
    }
    return indexCache;
}

/** Forget the index read, for a test that writes another one. */
export function forgetBundleIndex(): void {
    indexCache = undefined;
}

function hexOf(digest: string): string {
    const match = DIGEST.exec(digest);
    if (!match) throw new BundleUnavailable("This Polaris names an app bundle it cannot read.");
    return match[1] as string;
}

/** The folder a bundle is unpacked into. */
export function bundleDir(id: string, digest: string): string {
    return join(bundleRoot(), id, hexOf(digest));
}

/** Registry host and repository to fetch from: the index's, else the image's. */
export function registryOf(index: BundleIndex): { host: string; repository: string } {
    const location = (index.registry || loadEnv().POLARIS_WEB_IMAGE).replace(/:[^/]*$/, "");
    const [host, ...rest] = location.split("/");
    if (!host || rest.length === 0)
        throw new BundleUnavailable("This Polaris does not know where its apps are published.");
    return { host, repository: rest.join("/") };
}

/** An anonymous pull token, which is all a public package needs. */
export async function pullToken(
    host: string,
    repository: string,
    signal: AbortSignal
): Promise<string | null> {
    const url = `https://${host}/token?service=${encodeURIComponent(host)}&scope=${encodeURIComponent(`repository:${repository}:pull`)}`;
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    return typeof body?.token === "string" ? body.token : null;
}

/** How far a download has got, for a screen showing it. */
export type DownloadProgress = (received: number, total: number) => void;

/** A bundle's bytes, from the registry, by digest. Bounded in size and time. */
export async function download(
    index: BundleIndex,
    ref: Pick<BundleRef, "digest" | "size">,
    progress?: DownloadProgress
): Promise<Buffer> {
    const { host, repository } = registryOf(index);
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
        const token = await pullToken(host, repository, signal);
        response = await fetch(`https://${host}/v2/${repository}/blobs/${ref.digest}`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
            signal
        });
    } catch (error) {
        throw new BundleUnavailable(`Polaris could not reach ${host} to download it.`, {
            cause: error
        });
    }
    if (response.status === 404) {
        throw new BundleUnavailable(
            "It is no longer published for this version of Polaris. Update Polaris, then try again."
        );
    }
    if (!response.ok)
        throw new BundleUnavailable(`${host} answered ${response.status} when asked for it.`);
    const length = Number(response.headers.get("content-length") ?? ref.size);
    if (length > MAX_BUNDLE_BYTES || ref.size > MAX_BUNDLE_BYTES)
        throw new BundleUnavailable("What was published for it is larger than any app.");
    if (!response.body) return Buffer.from(await response.arrayBuffer());
    // Read as it arrives, so a screen can show how far it got and an answer
    // longer than any app is cut off rather than kept.
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > MAX_BUNDLE_BYTES)
                throw new BundleUnavailable("What was published for it is larger than any app.");
            chunks.push(value);
            progress?.(received, ref.size || length);
        }
    } catch (error) {
        if (error instanceof BundleUnavailable) throw error;
        throw new BundleUnavailable(`The download from ${host} was cut off.`, { cause: error });
    }
    return Buffer.concat(chunks);
}

export function verify(bytes: Buffer, ref: Pick<BundleRef, "digest">): void {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hexOf(ref.digest)) {
        throw new BundleUnavailable(
            "What was downloaded is not what this Polaris was built with, so it was refused."
        );
    }
}

export async function unpack(bytes: Buffer, id: string, target: string): Promise<void> {
    const zip = await JSZip.loadAsync(bytes);
    const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
    await rm(temporary, { recursive: true, force: true });
    try {
        for (const entry of Object.values(zip.files)) {
            if (entry.dir) continue;
            if (!ENTRY.test(entry.name))
                throw new BundleUnavailable("The bundle holds a file it may not.");
            const to = join(temporary, ...entry.name.split("/"));
            if (!to.startsWith(temporary + sep))
                throw new BundleUnavailable("The bundle holds a file it may not.");
            await mkdir(dirname(to), { recursive: true });
            await writeFile(to, await entry.async("nodebuffer"));
        }
        const manifest = JSON.parse(
            await readFile(join(temporary, "manifest.json"), "utf8")
        ) as BundleManifest;
        if (manifest.id !== id) {
            throw new BundleUnavailable("The bundle is not the app it was fetched for.");
        }
        if (manifest.format !== BUNDLE_FORMAT) {
            throw new BundleIncompatible(
                "It is packed in a way this version of Polaris cannot read.",
                manifest.format > BUNDLE_FORMAT ? "dashboard" : "app"
            );
        }
        await rm(target, { recursive: true, force: true });
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

/**
 * Every other build of this app, which nothing will load again. The one in use
 * and the one before it stay: that one is what a rollback goes back to, and what
 * a page opened before an update still loads its files from.
 */
export async function dropOthers(id: string): Promise<void> {
    const dir = join(bundleRoot(), id);
    const state = await readBundleState(id);
    const keep = new Set([STATE_FILE]);
    for (const pin of [state?.current, state?.previous]) if (pin) keep.add(hexOf(pin.digest));
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
        entries
            .filter((entry) => !keep.has(entry) && !entry.startsWith(`${STATE_FILE}.`))
            .map((entry) => rm(join(dir, entry), { recursive: true, force: true }))
    );
}

const STATE_FILE = "state.json";

const Digest = z.string().regex(DIGEST);

const Pin = z.object({
    digest: Digest,
    /** Where it came from: the image's own bundle, or an update of the app alone. */
    source: z.enum(["image", "registry"]),
    version: z.string().max(64).optional(),
    revision: z.string().max(64).optional(),
    notes: z.string().max(300).optional()
});

const BundleStateSchema = z.object({
    current: Pin,
    previous: Pin.nullable().optional(),
    /** The bundle the image named when this was written. When the image names
     *  another one, the dashboard was updated and its bundle takes over. */
    image: Digest.nullable()
});

/** Which build of an app this server runs, and the one before it. */
export type BundleState = z.infer<typeof BundleStateSchema>;
export type BundlePin = z.infer<typeof Pin>;

/** The app's state on the volume, or null when there is none or it is unreadable. */
export async function readBundleState(id: string): Promise<BundleState | null> {
    try {
        const text = await readFile(join(bundleRoot(), id, STATE_FILE), "utf8");
        const parsed = BundleStateSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Written beside and renamed over, so a cut-off write never leaves half a file. */
export async function writeBundleState(id: string, state: BundleState): Promise<void> {
    const dir = join(bundleRoot(), id);
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `${STATE_FILE}.${process.pid}-${Date.now()}`);
    await writeFile(temporary, `${JSON.stringify(BundleStateSchema.parse(state), null, 2)}\n`);
    await rename(temporary, join(dir, STATE_FILE));
}

/** The image's bundle of an app, unpacked if it is not yet. */
async function ensureImageBundle(index: BundleIndex, id: string, ref: BundleRef): Promise<string> {
    const target = bundleDir(id, ref.digest);
    if (existsSync(join(target, "manifest.json"))) return target;
    const seed = join(imageBundleDir(), ref.file);
    const bytes = existsSync(seed) ? await readFile(seed) : await download(index, ref);
    verify(bytes, ref);
    await mkdir(dirname(target), { recursive: true });
    await unpack(bytes, id, target);
    return target;
}

/** Kept on the process rather than in this module: Next evaluates a module once
 *  per bundle layer, and two copies must not unpack the same app over each other. */
const inflight: Map<string, Promise<string>> = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris.app-bundles.inflight")
] ??= new Map()) as Map<string, Promise<string>>;

/**
 * The folder holding this image's bundle of an app, fetched and unpacked if it
 * is not there yet. Throws `BundleUnavailable` with the reason when it cannot be.
 */
export function ensureBundle(id: string): Promise<string> {
    const running = inflight.get(id);
    if (running) return running;
    const work = (async () => {
        const index = bundleIndex();
        const ref = index?.apps[id];
        if (!index || !ref)
            throw new BundleUnavailable("This version of Polaris was built without it.");
        // An app updated on its own stays on that update for as long as the
        // dashboard is the one it was updated under. A dashboard update brings
        // the image's own bundle - the newest there was when the image was built -
        // and an install from before any of this has no state yet and gets the
        // image's, exactly as it did.
        const state = await readBundleState(id);
        if (state && state.image === ref.digest && state.current.digest !== ref.digest) {
            const pinned = bundleDir(id, state.current.digest);
            if (existsSync(join(pinned, "manifest.json"))) return pinned;
        }
        const target = await ensureImageBundle(index, id, ref);
        if (state?.current.digest !== ref.digest || state.image !== ref.digest) {
            const manifest = await readManifest(target);
            const kept = state?.current.digest === ref.digest ? state.previous : state?.current;
            await writeBundleState(id, {
                current: {
                    digest: ref.digest,
                    source: "image",
                    ...(manifest.version ? { version: manifest.version } : {})
                },
                previous: kept ?? null,
                image: ref.digest
            });
        }
        // The previous build's folder is the one the dashboard this one replaces is
        // still loading the app's code from while it serves, so it goes once that
        // dashboard has been retired rather than from under it.
        void afterPredecessor()
            .then(() => dropOthers(id))
            .catch(() => undefined);
        return target;
    })().finally(() => inflight.delete(id));
    inflight.set(id, work);
    return work;
}

/** Take an app's code off this server. Its data stays where it is. */
export async function removeBundle(id: string): Promise<void> {
    await rm(join(bundleRoot(), id), { recursive: true, force: true });
}

export async function readManifest(dir: string): Promise<BundleManifest> {
    return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as BundleManifest;
}
