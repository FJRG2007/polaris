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
import { createHash } from "node:crypto";
import { loadEnv } from "@polaris/config";
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
function registryOf(index: BundleIndex): { host: string; repository: string } {
    const location = (index.registry || loadEnv().POLARIS_WEB_IMAGE).replace(/:[^/]*$/, "");
    const [host, ...rest] = location.split("/");
    if (!host || rest.length === 0)
        throw new BundleUnavailable("This Polaris does not know where its apps are published.");
    return { host, repository: rest.join("/") };
}

/** An anonymous pull token, which is all a public package needs. */
async function pullToken(
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

async function download(index: BundleIndex, ref: BundleRef): Promise<Buffer> {
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
    if (length > MAX_BUNDLE_BYTES)
        throw new BundleUnavailable("What was published for it is larger than any app.");
    return Buffer.from(await response.arrayBuffer());
}

function verify(bytes: Buffer, ref: BundleRef): void {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hexOf(ref.digest)) {
        throw new BundleUnavailable(
            "What was downloaded is not what this Polaris was built with, so it was refused."
        );
    }
}

async function unpack(bytes: Buffer, id: string, target: string): Promise<void> {
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
        if (manifest.id !== id || manifest.format !== BUNDLE_FORMAT) {
            throw new BundleUnavailable("The bundle is not the app it was fetched for.");
        }
        await rm(target, { recursive: true, force: true });
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

/** Every other build of this app, which nothing will load again. */
async function dropOthers(id: string, keep: string): Promise<void> {
    const dir = join(bundleRoot(), id);
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
        entries
            .filter((entry) => entry !== keep)
            .map((entry) => rm(join(dir, entry), { recursive: true, force: true }))
    );
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
        const target = bundleDir(id, ref.digest);
        if (existsSync(join(target, "manifest.json"))) return target;
        const seed = join(imageBundleDir(), ref.file);
        const bytes = existsSync(seed) ? await readFile(seed) : await download(index, ref);
        verify(bytes, ref);
        await mkdir(dirname(target), { recursive: true });
        await unpack(bytes, id, target);
        await dropOthers(id, hexOf(ref.digest));
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
