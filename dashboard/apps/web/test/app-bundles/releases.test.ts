/**
 * An app updated on its own: read from its channel, verified, swapped in the
 * running process, kept across a restart, given back by a dashboard update,
 * rolled back - and an install from before any of this moved over with no one
 * doing anything. The registry is a stub; no host daemon is involved, which is
 * the limited edition's whole situation.
 */

import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { resetEnvCache } from "@polaris/config";
import { tinyBundle, type TinyBundle } from "./helpers/tiny-bundle";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const installed = new Set<string>(["tiny"]);
vi.mock("@/lib/apps/install-presence", () => ({
    isAppInstalled: async (id: string) => installed.has(id),
    invalidateInstallPresence: () => undefined
}));
vi.mock("@/lib/app-bundles/shared-server", () => ({
    sharedServerModules: () => new Set<string>(),
    sharedPiece: () => ({}),
    provideShared: () => undefined
}));
vi.mock("@/lib/deploy/dashboard-peers", () => ({
    afterPredecessor: () => Promise.resolve(),
    predecessorRetired: () => true
}));

const BUNDLER = pathToFileURL(
    join(resolve(__dirname, "../../../.."), "packages/app-host/bundler/build.mjs")
).href;
type OciManifest = (
    id: string,
    digest: string,
    size: number,
    about?: Record<string, string | undefined>
) => { bytes: string; digest: string };

let root = "";
let ociManifest: OciManifest;
const builds: Record<string, TinyBundle> = {};
const saved = {
    data: process.env.POLARIS_DATA_DIR,
    bundles: process.env.POLARIS_APP_BUNDLES_DIR,
    phase: process.env.NEXT_PHASE,
    hostd: process.env.POLARIS_HOSTD_UPDATE_CMD
};

/** What the stub registry publishes on the app's channel now. */
const channel: {
    bundle?: TinyBundle;
    hostApi?: string;
    blob?: Buffer;
    manifest?: string;
    hold?: Promise<void>;
    requests: string[];
} = {
    requests: []
};

function writeIndex(digest: TinyBundle) {
    const image = join(root, "image");
    mkdirSync(image, { recursive: true });
    writeFileSync(join(image, "tiny.zip"), digest.bytes);
    writeFileSync(
        join(image, "index.json"),
        JSON.stringify({
            format: 1,
            build: "",
            registry: "registry.test/polaris/dashboard",
            apps: { tiny: { file: "tiny.zip", digest: digest.digest, size: digest.size } }
        })
    );
}

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "polaris-releases-"));
    ociManifest = ((await import(/* @vite-ignore */ BUNDLER)) as { ociManifest: OciManifest })
        .ociManifest;
    builds.bootFails = await tinyBundle("tiny", { label: "boot", bootFails: true });
    for (const label of ["one", "two", "three"])
        builds[label] = await tinyBundle("tiny", { label, version: `0.${label.length}.0` });
    builds.broken = await tinyBundle("tiny", { label: "broken", broken: true });
    writeIndex(builds.one!);
    process.env.POLARIS_APP_BUNDLES_DIR = join(root, "image");
    process.env.POLARIS_DATA_DIR = join(root, "data");
    process.env.NEXT_PHASE = "phase-production-build";
    // The limited edition: no host daemon, no updater command.
    delete process.env.POLARIS_HOSTD_UPDATE_CMD;
    resetEnvCache();
    (await import("@/lib/app-bundles/store")).forgetBundleIndex();

    vi.stubGlobal("fetch", async (input: string | URL) => {
        const url = String(input);
        channel.requests.push(url);
        await channel.hold;
        if (url.includes("/token?")) return Response.json({ token: "anonymous" });
        const bundle = channel.bundle;
        if (url.endsWith("/manifests/latest-app-tiny") && channel.manifest !== undefined) {
            const body = channel.manifest;
            return new Response(
                new ReadableStream({
                    start: (stream) => {
                        stream.enqueue(new TextEncoder().encode(body));
                        stream.close();
                    }
                })
            );
        }
        if (url.endsWith("/manifests/latest-app-tiny") && bundle) {
            const oci = ociManifest("tiny", bundle.digest, bundle.size, {
                version: "0.2.0",
                hostApi: channel.hostApi ?? "1.0",
                notes: "A change line."
            });
            return new Response(oci.bytes, { headers: { "docker-content-digest": oci.digest } });
        }
        if (bundle && url.endsWith(`/blobs/${bundle.digest}`)) {
            return new Response(new Uint8Array(channel.blob ?? bundle.bytes));
        }
        return new Response("not found", { status: 404 });
    });
});

afterAll(() => {
    vi.unstubAllGlobals();
    process.env.POLARIS_DATA_DIR = saved.data;
    process.env.POLARIS_APP_BUNDLES_DIR = saved.bundles;
    process.env.NEXT_PHASE = saved.phase;
    if (saved.hostd !== undefined) process.env.POLARIS_HOSTD_UPDATE_CMD = saved.hostd;
    resetEnvCache();
    rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    channel.blob = undefined;
    channel.hostApi = undefined;
    channel.manifest = undefined;
    channel.hold = undefined;
    channel.requests = [];
});

const label = async () =>
    (
        (await import("@/lib/app-bundles/loader")).loadedBundle("tiny")?.server
            .extension as unknown as { label?: string } | undefined
    )?.label;

const stateFile = () => join(root, "data", "apps", "tiny", "state.json");
const readState = () => JSON.parse(readFileSync(stateFile(), "utf8"));

/** A restart: nothing loaded, the volume as it was left. */
async function restart() {
    const loader = await import("@/lib/app-bundles/loader");
    loader.unloadBundle("tiny");
    await loader.loadBundle("tiny");
}

describe("a release on an app's channel", () => {
    it("is read from the manifest the bundler publishes", async () => {
        const { readRelease } = await import("@/lib/app-bundles/releases");
        const oci = ociManifest("tiny", builds.two!.digest, builds.two!.size, {
            version: "0.2.0",
            hostApi: "1.0",
            revision: "abc123",
            notes: "A change line."
        });
        expect(readRelease(Buffer.from(oci.bytes), oci.digest)).toEqual({
            digest: builds.two!.digest,
            size: builds.two!.size,
            version: "0.2.0",
            revision: "abc123",
            notes: "A change line.",
            hostApi: "1.0"
        });
    });

    it("is refused when it is not what the registry named, or not an app", async () => {
        const { readRelease } = await import("@/lib/app-bundles/releases");
        const oci = ociManifest("tiny", builds.two!.digest, builds.two!.size);
        expect(() => readRelease(Buffer.from(oci.bytes), `sha256:${"0".repeat(64)}`)).toThrow(
            /other than what it named/
        );
        expect(() => readRelease(Buffer.from("{}"))).toThrow(/not an app/);
        expect(() => readRelease(Buffer.from("nope"))).toThrow(/not an app/);
    });

    it("is refused when an answer with no length runs past any manifest", async () => {
        const { latestRelease } = await import("@/lib/app-bundles/releases");
        channel.manifest = "x".repeat(65 * 1024);
        await expect(latestRelease("tiny", { force: true })).rejects.toThrow(/not an app/);
    });
});

describe("an app's own updates", () => {
    it("moves an install from before any of this onto the image's bundle, with nothing to do", async () => {
        expect(existsSync(stateFile())).toBe(false);
        await (await import("@/lib/app-bundles/loader")).loadBundle("tiny");
        expect(await label()).toBe("one");
        expect(readState()).toMatchObject({
            current: { digest: builds.one!.digest, source: "image" },
            previous: null,
            image: builds.one!.digest
        });
    });

    it("refuses a build that needs a newer Polaris before downloading it", async () => {
        const { updateApp } = await import("@/lib/app-bundles/releases");
        channel.bundle = builds.two;
        channel.hostApi = "1.99";
        expect(await updateApp("tiny")).toEqual({ ok: false, code: "needsPolaris" });
        expect(channel.requests.some((url) => url.includes("/blobs/"))).toBe(false);
        expect(await label()).toBe("one");
    });

    it("keeps the running build when the download is not what was published", async () => {
        const { updateApp } = await import("@/lib/app-bundles/releases");
        channel.bundle = builds.two;
        channel.blob = Buffer.concat([builds.two!.bytes, Buffer.from("x")]);
        expect(await updateApp("tiny")).toMatchObject({ ok: false });
        expect(await label()).toBe("one");
        expect(readState().current.digest).toBe(builds.one!.digest);
    });

    it("keeps the running build when the new one does not start, and drops what it unpacked", async () => {
        const { updateApp } = await import("@/lib/app-bundles/releases");
        channel.bundle = builds.broken;
        expect(await updateApp("tiny")).toEqual({ ok: false, code: "failed" });
        expect(await label()).toBe("one");
        expect(readState().current.digest).toBe(builds.one!.digest);
        const hex = builds.broken!.digest.slice("sha256:".length);
        expect(existsSync(join(root, "data", "apps", "tiny", hex))).toBe(false);
    });

    it("swaps to the newest build in the running process, and keeps it across a restart", async () => {
        const { updateApp, appReleaseStatuses } = await import("@/lib/app-bundles/releases");
        const { loadedBundle } = await import("@/lib/app-bundles/loader");
        channel.bundle = builds.two;
        expect(await updateApp("tiny")).toEqual({ ok: true, changed: true });
        expect(await label()).toBe("two");
        // A page opened before the swap still finds its files.
        expect(loadedBundle("tiny")?.previous?.version).toBe(builds.one!.digest.slice(7));
        expect(readState()).toMatchObject({
            current: { digest: builds.two!.digest, source: "registry", notes: "A change line." },
            previous: { digest: builds.one!.digest },
            image: builds.one!.digest
        });
        expect(await updateApp("tiny")).toEqual({ ok: true, changed: false });
        await restart();
        expect(await label()).toBe("two");
        const [row] = await appReleaseStatuses();
        expect(row).toMatchObject({ id: "tiny", running: true, checkFailed: false });
        expect(row?.available?.digest).toBe(row?.installed?.digest);
        expect(row?.previous?.digest).toBe(builds.one!.digest);
    });

    it("goes back to the build before, and forward again", async () => {
        const { rollbackApp } = await import("@/lib/app-bundles/releases");
        expect(await rollbackApp("tiny")).toEqual({ ok: true, changed: true });
        expect(await label()).toBe("one");
        expect(readState()).toMatchObject({
            current: { digest: builds.one!.digest },
            previous: { digest: builds.two!.digest }
        });
        await restart();
        expect(await label()).toBe("one");
        expect(await rollbackApp("tiny")).toEqual({ ok: true, changed: true });
        expect(await label()).toBe("two");
    });

    it("hands the app the image's bundle when the dashboard is updated", async () => {
        writeIndex(builds.three!);
        (await import("@/lib/app-bundles/store")).forgetBundleIndex();
        await restart();
        expect(await label()).toBe("three");
        expect(readState()).toMatchObject({
            current: { digest: builds.three!.digest, source: "image" },
            previous: { digest: builds.two!.digest },
            image: builds.three!.digest
        });
    });

    it("refuses an app that is not installed, and one already being updated", async () => {
        const { updateApp, rollbackApp, anyAppUpdating, appUpdating } =
            await import("@/lib/app-bundles/releases");
        installed.delete("tiny");
        expect(await updateApp("tiny")).toEqual({ ok: false, code: "notInstalled" });
        installed.add("tiny");
        channel.bundle = builds.two;
        let release = () => undefined as void;
        channel.hold = new Promise((done) => (release = done));
        const first = updateApp("tiny");
        await vi.waitFor(() => expect(appUpdating("tiny")).not.toBeNull());
        expect(anyAppUpdating()).toBe(false);
        release();
        expect(await rollbackApp("tiny")).toEqual({ ok: false, code: "busy" });
        expect(await first).toMatchObject({ ok: true });
        expect(await updateApp("../etc")).toEqual({ ok: false, code: "unknown" });
    });

    it("serves and records a build brought up by an update even when its boot work fails", async () => {
        const { updateApp, anyAppUpdating } = await import("@/lib/app-bundles/releases");
        (await import("@/lib/app-bundles/loader")).unloadBundle("tiny");
        channel.bundle = builds.bootFails;
        let release = () => undefined as void;
        channel.hold = new Promise((done) => (release = done));
        const update = updateApp("tiny");
        await vi.waitFor(() => expect(anyAppUpdating()).toBe(true));
        release();
        expect(await update).toEqual({ ok: true, changed: true });
        expect(await label()).toBe("boot");
        expect(readState().current.digest).toBe(builds.bootFails!.digest);
        const hex = builds.bootFails!.digest.slice("sha256:".length);
        expect(existsSync(join(root, "data", "apps", "tiny", hex, "manifest.json"))).toBe(true);
    });
});
