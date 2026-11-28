/**
 * Apps from the published catalogue: an existing install discovers an app its
 * image was built without, gated by the host API it needs, from a catalogue it
 * trusts only when the signature checks out and never trades for an older one.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));

import { POLARIS_APPS } from "@/lib/apps";
import { HOST_API } from "@polaris/app-host/version";
import { primaryAction } from "@/lib/apps/marketplace-store";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { findApp, isInstallable, setRuntimeApps, catalogApps } from "@/lib/apps/catalog";
import { KNOWN_PERMISSIONS, newerOrSame, openAppCatalog } from "@/lib/apps/runtime-catalog";
import { appEntryFit, readAppCatalog, runtimeViews, type RuntimeAppEntry } from "@/lib/apps/runtime-catalog-schema";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = [{ id: "test-key", publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex") }];
const signatureOf = (data: Uint8Array) => JSON.stringify({ keyId: "test-key", signature: sign(null, data, privateKey).toString("base64") });

const [major, minor] = HOST_API.split(".").map(Number) as [number, number];

const entry = (overrides: Partial<Record<keyof RuntimeAppEntry, unknown>> = {}) => ({
    id: "bakery",
    version: "1.0.0",
    hostApi: HOST_API,
    minPolaris: "0.1.140",
    name: { "en-US": "Bakery", "es-ES": "Panadería" },
    summary: { "en-US": "Run a bakery.", "es-ES": "Lleva una panadería." },
    description: { "en-US": "Orders and ovens." },
    category: "Productivity",
    nav: { category: "work", permission: "deploy.read" },
    permissions: ["deploy.read"],
    bundle: { file: "bakery.zip", digest: `sha256:${"a".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z",
    ...overrides
});

const catalog = (apps: unknown[], issued = "2026-11-28T00:00:00.000Z") => ({ schema: 1, kind: "apps", issued, apps });

beforeEach(() => registerRuntimeApps([]));

describe("reading the published catalogue", () => {
    it("keeps every entry that reads and drops one it cannot, alone", () => {
        const read = readAppCatalog(catalog([entry(), entry({ id: "broken", bundle: { digest: "md5:x" } }), entry({ id: "nameless", name: "x" })]));
        expect(read?.apps.map((app) => app.id)).toEqual(["bakery"]);
    });

    it("keeps the first of a repeated id", () => {
        const read = readAppCatalog(catalog([entry(), entry({ version: "9.9.9" })]));
        expect(read?.apps).toHaveLength(1);
        expect(read?.apps[0]?.version).toBe("1.0.0");
    });

    it("refuses another kind of catalogue, so a plugin catalog's signed bytes are never read as apps", () => {
        expect(readAppCatalog({ schema: 1, issued: "2026-11-28T00:00:00.000Z", plugins: [] })).toBeNull();
    });

    it("takes logos only from the catalogue's own release", () => {
        expect(readAppCatalog(catalog([entry({ logo: "https://example.com/logo.svg" })]))?.apps).toHaveLength(0);
        const own = "https://github.com/FJRG2007/polaris/releases/download/app-catalog/bakery.svg";
        expect(readAppCatalog(catalog([entry({ logo: own })]))?.apps[0]?.logo).toBe(own);
    });
});

describe("signature", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(catalog([entry()])));

    it("opens a catalogue signed by a trusted key", () => {
        expect(openAppCatalog(bytes, signatureOf(bytes), keys)?.apps).toHaveLength(1);
    });

    it("refuses one changed after signing, signed by another key, or unsigned", () => {
        const changed = new TextEncoder().encode(JSON.stringify(catalog([entry({ version: "6.6.6" })])));
        expect(openAppCatalog(changed, signatureOf(bytes), keys)).toBeNull();
        const other = generateKeyPairSync("ed25519").privateKey;
        const forged = JSON.stringify({ keyId: "test-key", signature: sign(null, bytes, other).toString("base64") });
        expect(openAppCatalog(bytes, forged, keys)).toBeNull();
        expect(openAppCatalog(bytes, "", keys)).toBeNull();
    });

    it("never trades a held catalogue for one issued earlier", () => {
        const held = readAppCatalog(catalog([entry()], "2026-11-28T00:00:00.000Z"));
        const older = readAppCatalog(catalog([], "2026-11-01T00:00:00.000Z"));
        const newer = readAppCatalog(catalog([], "2026-11-29T00:00:00.000Z"));
        expect(newerOrSame(older!, held)).toBe(false);
        expect(newerOrSame(newer!, held)).toBe(true);
        expect(newerOrSame(older!, null)).toBe(true);
    });
});

describe("minimum host", () => {
    const read = (overrides: Parameters<typeof entry>[0]) => readAppCatalog(catalog([entry(overrides)]))!.apps[0]!;

    it("runs an app on the host API it was written for", () => {
        expect(appEntryFit(read({}), KNOWN_PERMISSIONS)).toEqual({ ok: true });
    });

    it("asks for a newer Polaris when the app needs a newer host API", () => {
        expect(appEntryFit(read({ hostApi: `${major}.${minor + 1}` }), KNOWN_PERMISSIONS)).toEqual({
            ok: false,
            needs: "polaris",
            version: "0.1.140"
        });
    });

    it("asks for a newer Polaris for a permission or core tables this one does not have", () => {
        const unknown = read({ permissions: ["bakery.use"], nav: { category: "work", permission: "bakery.use" } });
        expect(appEntryFit(unknown, KNOWN_PERMISSIONS).ok).toBe(false);
        expect(appEntryFit(read({ coreTables: true }), KNOWN_PERMISSIONS).ok).toBe(false);
    });

    it("leaves out an app written for a host API this one has moved past", () => {
        const old = read({ hostApi: `${major - 1}.0` });
        expect(appEntryFit(old, KNOWN_PERMISSIONS)).toEqual({ ok: false, needs: "app" });
        expect(runtimeViews({ issued: "2026-11-28T00:00:00.000Z", apps: [old] }, KNOWN_PERMISSIONS, "en-US")).toEqual([]);
    });
});

describe("merged into the catalog every screen reads", () => {
    const views = (apps: unknown[], locale = "en-US") => runtimeViews(readAppCatalog(catalog(apps)), KNOWN_PERMISSIONS, locale);

    it("lists a new app, in the reader's language, installable, under its own address", () => {
        registerRuntimeApps(views([entry()], "es-ES"));
        const app = findApp("bakery");
        expect(app).toMatchObject({ name: "Panadería", opensAt: "/x/bakery", runtime: { version: "1.0.0" } });
        expect(isInstallable(app!)).toBe(true);
        expect(POLARIS_APPS.find((nav) => nav.id === "bakery")).toMatchObject({
            href: "/x/bakery",
            requiresApp: "bakery",
            permission: "deploy.read"
        });
    });

    it("offers an app that needs a newer Polaris as an update, not an install, and gives it no nav", () => {
        registerRuntimeApps(views([entry({ hostApi: `${major}.${minor + 1}` })]));
        const app = findApp("bakery")!;
        expect(isInstallable(app)).toBe(false);
        expect(primaryAction(app, { installs: [], canInstall: true, installing: false })).toEqual({
            kind: "needsPolaris",
            version: "0.1.140"
        });
        expect(POLARIS_APPS.some((nav) => nav.id === "bakery")).toBe(false);
    });

    it("never replaces an app this image carries", () => {
        const baked = findApp("hospitality");
        registerRuntimeApps(views([entry({ id: "hospitality", name: { "en-US": "Impostor" } })]));
        expect(findApp("hospitality")).toBe(baked);
        expect(catalogApps().filter((app) => app.id === "hospitality")).toHaveLength(1);
        expect(POLARIS_APPS.filter((nav) => nav.id === "hospitality")).toHaveLength(1);
    });

    it("takes an app off again when the catalogue withdraws it", () => {
        registerRuntimeApps(views([entry()]));
        registerRuntimeApps(views([]));
        expect(findApp("bakery")).toBeUndefined();
        expect(POLARIS_APPS.some((nav) => nav.id === "bakery")).toBe(false);
        setRuntimeApps([]);
    });
});
