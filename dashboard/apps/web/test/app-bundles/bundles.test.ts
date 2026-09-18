/**
 * The real apps, built into bundles, unpacked the way an install unpacks them
 * and loaded into this process the way the dashboard loads them.
 *
 * What this proves is the server half: that each bundle carries none of the
 * libraries the dashboard shares, asks only for ones the dashboard provides,
 * evaluates, and hands back the app's extension, routes and actions. That a
 * page drawn from one renders in the browser is a production build's to prove.
 */

import JSZip from "jszip";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { resetEnvCache } from "@polaris/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sharedServerModules } from "@/lib/app-bundles/shared-server";
import { SHARED_CLIENT_MODULES } from "@/components/app-bundles/runtime";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");
const BUNDLER = pathToFileURL(join(DASHBOARD, "packages/app-host/bundler/build.mjs")).href;

type Built = { manifest: { id: string; shared: { server: string[]; client: string[] } }; digest: string; size: number };

let root = "";
let built: Built[] = [];
const saved = {
    data: process.env.POLARIS_DATA_DIR,
    bundles: process.env.POLARIS_APP_BUNDLES_DIR,
    phase: process.env.NEXT_PHASE
};

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "polaris-bundles-"));
    const image = join(root, "image");
    const { appPackages, buildAppBundle } = (await import(/* @vite-ignore */ BUNDLER)) as {
        appPackages: (dashboard: string) => string[];
        buildAppBundle: (dir: string, out: string, build: string) => Promise<Built>;
    };
    built = [];
    for (const dir of appPackages(DASHBOARD)) built.push(await buildAppBundle(dir, image, "test"));
    const apps = Object.fromEntries(
        built.map((bundle) => [bundle.manifest.id, { file: `${bundle.manifest.id}.zip`, digest: bundle.digest, size: bundle.size }])
    );
    writeFileSync(join(image, "index.json"), JSON.stringify({ format: 1, build: "test", apps }));
    process.env.POLARIS_APP_BUNDLES_DIR = image;
    process.env.POLARIS_DATA_DIR = join(root, "data");
    // The build's placeholders stand in for the secrets nothing here reads.
    process.env.NEXT_PHASE = "phase-production-build";
    resetEnvCache();
    (await import("@/lib/app-bundles/store")).forgetBundleIndex();
}, 120_000);

afterAll(() => {
    process.env.POLARIS_DATA_DIR = saved.data;
    process.env.POLARIS_APP_BUNDLES_DIR = saved.bundles;
    process.env.NEXT_PHASE = saved.phase;
    resetEnvCache();
    rmSync(root, { recursive: true, force: true });
});

describe("app bundles", () => {
    it("are built for every app package", () => {
        expect(built.map((bundle) => bundle.manifest.id).sort()).toEqual(["game-servers", "home"]);
    });

    it("ask only for libraries the dashboard provides", () => {
        const server = sharedServerModules();
        for (const bundle of built) {
            expect(bundle.manifest.shared.server.filter((spec) => !server.has(spec)), bundle.manifest.id).toEqual([]);
            expect(
                bundle.manifest.shared.client.filter((spec) => !SHARED_CLIENT_MODULES.includes(spec)),
                bundle.manifest.id
            ).toEqual([]);
        }
    });

    it("carry none of the libraries the dashboard shares", () => {
        for (const bundle of built) {
            const server = readFileSync(join(root, "image", bundle.manifest.id, "server", "index.cjs"), "utf8");
            for (const library of ["react", "next", "zod", "@prisma/client"]) {
                expect(server, `${bundle.manifest.id} carries ${library}`).not.toMatch(
                    new RegExp(`node_modules/${library.replace("/", "\\/")}/`)
                );
            }
            expect(server).not.toMatch(/packages\/(core|db|ui|config)\/src\//);
        }
    });

    it("build to the same bytes twice", async () => {
        const { buildAppBundle } = (await import(/* @vite-ignore */ BUNDLER)) as {
            buildAppBundle: (dir: string, out: string, build: string) => Promise<Built>;
        };
        const again = await buildAppBundle(join(DASHBOARD, "apps/places"), join(root, "again"), "test");
        expect(again.digest).toBe(built.find((bundle) => bundle.manifest.id === "home")?.digest);
    }, 60_000);

    it("load into this process with their extension, routes and actions", async () => {
        const { loadBundle } = await import("@/lib/app-bundles/loader");
        for (const id of ["home", "game-servers"]) {
            const bundle = await loadBundle(id);
            expect(bundle.server.extension.id).toBe(id);
            expect(bundle.manifest.routes.length).toBeGreaterThan(5);
            for (const route of bundle.manifest.routes) {
                const module = await bundle.server.routes[route]?.();
                const handler = route.startsWith("page ") ? module?.default : module?.GET ?? module?.POST;
                expect(typeof handler, `${id} ${route}`).toBe("function");
            }
            for (const [module, names] of Object.entries(bundle.manifest.actions)) {
                const loaded = await bundle.server.actions[module]?.();
                for (const name of names) expect(typeof loaded?.[name], `${id} ${module}#${name}`).toBe("function");
            }
        }
    }, 60_000);

    it("leave only this build's copy on the volume", () => {
        for (const id of ["home", "game-servers"]) {
            expect(readdirSync(join(root, "data", "apps", id))).toHaveLength(1);
        }
    });
});

describe("a bundle that is not what the image says", () => {
    it("is refused before anything is unpacked", async () => {
        const store = await import("@/lib/app-bundles/store");
        const image = join(root, "image");
        const index = JSON.parse(readFileSync(join(image, "index.json"), "utf8"));
        const forged = join(image, "forged.zip");
        writeFileSync(forged, Buffer.concat([readFileSync(join(image, "home.zip")), Buffer.from("x")]));
        index.apps.forged = { file: "forged.zip", digest: index.apps.home.digest, size: 1 };
        writeFileSync(join(image, "index.json"), JSON.stringify(index));
        store.forgetBundleIndex();
        await expect(store.ensureBundle("forged")).rejects.toThrow(/not what this Polaris was built with/);
        expect(existsSync(join(root, "data", "apps", "forged"))).toBe(false);
    });

    it("never writes a file outside its folder, whatever the file is called", async () => {
        const store = await import("@/lib/app-bundles/store");
        const image = join(root, "image");
        const zip = new JSZip();
        zip.file("manifest.json", JSON.stringify({ format: 1, id: "escape" }));
        zip.file("../outside.txt", "x");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        writeFileSync(join(image, "escape.zip"), bytes);
        const index = JSON.parse(readFileSync(join(image, "index.json"), "utf8"));
        index.apps.escape = {
            file: "escape.zip",
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            size: bytes.length
        };
        writeFileSync(join(image, "index.json"), JSON.stringify(index));
        store.forgetBundleIndex();
        const dir = await store.ensureBundle("escape").catch(() => null);
        for (const outside of [join(root, "data", "apps", "outside.txt"), join(root, "data", "apps", "escape", "outside.txt")]) {
            expect(existsSync(outside), outside).toBe(false);
        }
        if (dir) expect(readdirSync(dir).sort()).toEqual(["manifest.json", "outside.txt"]);
    });
});
