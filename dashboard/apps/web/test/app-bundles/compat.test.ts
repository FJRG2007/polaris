/**
 * A dashboard and an app bundle on different versions: one this dashboard
 * cannot run is refused before it is evaluated, and the app's screen is told
 * which update fixes it rather than failing.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetEnvCache } from "@polaris/config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tinyBundle } from "./helpers/tiny-bundle";
import type { BundleManifest } from "@/lib/app-bundles/store";

const installed = new Set<string>();
vi.mock("@/lib/apps/install-presence", () => ({
    isAppInstalled: async (id: string) => installed.has(id),
    invalidateInstallPresence: () => undefined
}));
// The shared table pulls in the whole dashboard; these bundles take nothing from it.
vi.mock("@/lib/app-bundles/shared-server", () => ({
    sharedServerModules: () => new Set<string>(),
    sharedPiece: () => ({}),
    provideShared: () => undefined
}));
vi.mock("@/lib/deploy/dashboard-peers", () => ({
    afterPredecessor: () => Promise.resolve(),
    predecessorRetired: () => true
}));

let root = "";
const saved = { data: process.env.POLARIS_DATA_DIR, bundles: process.env.POLARIS_APP_BUNDLES_DIR, phase: process.env.NEXT_PHASE };

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "polaris-compat-"));
    const image = join(root, "image");
    const apps: Record<string, unknown> = {};
    for (const [id, options] of [
        ["fits", {}],
        ["legacy", { hostApi: null }],
        ["too-new", { hostApi: "1.99" }],
        ["too-old", { hostApi: "0.9" }],
        ["next-format", { format: 2 }]
    ] as const) {
        const bundle = await tinyBundle(id, options);
        (await import("node:fs")).mkdirSync(image, { recursive: true });
        writeFileSync(join(image, `${id}.zip`), bundle.bytes);
        apps[id] = { file: `${id}.zip`, digest: bundle.digest, size: bundle.size };
    }
    writeFileSync(join(image, "index.json"), JSON.stringify({ format: 1, build: "", apps }));
    process.env.POLARIS_APP_BUNDLES_DIR = image;
    process.env.POLARIS_DATA_DIR = join(root, "data");
    process.env.NEXT_PHASE = "phase-production-build";
    resetEnvCache();
    (await import("@/lib/app-bundles/store")).forgetBundleIndex();
});

afterAll(() => {
    process.env.POLARIS_DATA_DIR = saved.data;
    process.env.POLARIS_APP_BUNDLES_DIR = saved.bundles;
    process.env.NEXT_PHASE = saved.phase;
    resetEnvCache();
    rmSync(root, { recursive: true, force: true });
});

beforeEach(() => installed.clear());

const manifest = (over: Partial<BundleManifest>): BundleManifest => ({
    format: 1,
    id: "x",
    build: "",
    server: "server/index.cjs",
    routes: [],
    actions: {},
    client: {},
    shared: { server: [], client: [] },
    ...over
});

describe("whether this dashboard can run a bundle", () => {
    it("accepts one built for its host API, and one built before bundles named one", async () => {
        const { checkCompatible } = await import("@/lib/app-bundles/loader");
        expect(() => checkCompatible(manifest({ hostApi: "1.0" }), new Set())).not.toThrow();
        expect(() => checkCompatible(manifest({}), new Set())).not.toThrow();
    });

    it("names the side that needs an update", async () => {
        const { checkCompatible } = await import("@/lib/app-bundles/loader");
        const { BundleIncompatible } = await import("@/lib/app-bundles/store");
        const cases: [Partial<BundleManifest>, "dashboard" | "app"][] = [
            [{ hostApi: "1.99" }, "dashboard"],
            [{ hostApi: "0.9" }, "app"],
            [{ format: 2 }, "dashboard"],
            [{ format: 0 }, "app"],
            [{ shared: { server: ["@polaris/not-yet"], client: [] } }, "dashboard"]
        ];
        for (const [over, update] of cases) {
            let caught: unknown;
            try {
                checkCompatible(manifest(over), new Set());
            } catch (error) {
                caught = error;
            }
            expect(caught, JSON.stringify(over)).toBeInstanceOf(BundleIncompatible);
            expect((caught as InstanceType<typeof BundleIncompatible>).update).toBe(update);
        }
    });
});

describe("an installed app on another version", () => {
    it("loads when it fits, and is shown as needing an update when it does not", async () => {
        const { prepareAppBundles, appFailure } = await import("@/lib/app-bundles/lifecycle");
        const { loadedBundle } = await import("@/lib/app-bundles/loader");
        for (const id of ["fits", "legacy", "too-new", "too-old", "next-format"]) installed.add(id);
        await prepareAppBundles();
        expect(loadedBundle("fits")).toBeDefined();
        expect(loadedBundle("legacy")).toBeDefined();
        expect(appFailure("fits")).toBeNull();
        expect(loadedBundle("too-new")).toBeUndefined();
        expect(appFailure("too-new")).toMatchObject({ update: "dashboard" });
        expect(appFailure("too-old")).toMatchObject({ update: "app" });
        expect(appFailure("next-format")).toMatchObject({ update: "dashboard" });
    });
});
