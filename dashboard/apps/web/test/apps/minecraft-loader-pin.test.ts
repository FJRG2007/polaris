/**
 * Holding a mod loader at the version a server installed.
 *
 * On 2026-10-03 NeoForge's repository added `modelVersion="1.1.0"` to its
 * `maven-metadata.xml`, the image's helper refused the document, and every
 * NeoForge server left on "latest" crash-looped on its next start - including one
 * with NeoForge 21.4.158 for 1.21.4 sitting on disk, perfectly runnable. The
 * helper answers from its own manifest, asking nobody, when it is given the exact
 * version that manifest records. These are the rules that write that version.
 *
 * The manifests under `fixtures/loader-manifests` are the helper's own shapes
 * (`ForgeManifest`, `FabricManifest`, `QuiltManifest` in itzg/mc-image-helper).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    envReader,
    isExactRelease,
    loaderPinState,
    loaderReleasedBy,
    loaderToPin,
    manifestPath,
    pinFromManifest,
    unpinVars
} from "@polaris-app/game-servers/src/lib/minecraft/loader-pin";

const FIXTURES = fileURLToPath(new URL("./fixtures/loader-manifests/", import.meta.url));
const manifest = (name: string) => readFileSync(`${FIXTURES}${name}.json`, "utf8");

/** The environment of the server from the incident: NeoForge on 1.21.4, and no
 *  loader version, so the image resolved "latest" on every start. */
const INCIDENT = { TYPE: "NEOFORGE", VERSION: "1.21.4" };

describe("which servers are held", () => {
    it("holds a loader left on latest, by leaving the variable empty or saying latest", () => {
        expect(loaderPinState(envReader(INCIDENT))).toEqual({
            state: "following",
            loader: "NeoForge",
            key: "NEOFORGE_VERSION"
        });
        expect(loaderPinState(envReader({ ...INCIDENT, NEOFORGE_VERSION: "LATEST" })).state).toBe(
            "following"
        );
        // Forge's own default is the recommended build, which moves just the same.
        expect(
            loaderPinState(envReader({ TYPE: "FORGE", VERSION: "1.20.1", FORGE_VERSION: "recommended" }))
                .state
        ).toBe("following");
    });

    it("keeps a version somebody already set, whoever set it", () => {
        // What the server from the incident was repaired with by hand.
        const held = envReader({ ...INCIDENT, NEOFORGE_VERSION: "21.4.158" });
        expect(loaderPinState(held)).toEqual({
            state: "held",
            loader: "NeoForge",
            key: "NEOFORGE_VERSION",
            version: "21.4.158"
        });
        expect(loaderToPin(held)).toBeNull();
        expect(pinFromManifest(held, manifest("neoforge"))).toBeNull();
    });

    it("reads Forge's older spelling the way the image does", () => {
        expect(
            loaderPinState(envReader({ TYPE: "FORGE", VERSION: "1.20.1", FORGEVERSION: "47.3.0" }))
        ).toMatchObject({ state: "held", version: "47.3.0" });
    });

    it("leaves a server on the newest Minecraft alone: there is no one version to hold", () => {
        for (const version of ["", "LATEST", "snapshot"]) {
            expect(loaderPinState(envReader({ TYPE: "NEOFORGE", VERSION: version })).state).toBe(
                "release"
            );
        }
        expect(isExactRelease("1.21.4")).toBe(true);
    });

    it("leaves an installer of somebody's own alone", () => {
        expect(
            loaderPinState(envReader({ ...INCIDENT, NEOFORGE_INSTALLER: "/data/installer.jar" })).state
        ).toBe("custom");
        expect(
            loaderPinState(
                envReader({ TYPE: "FABRIC", VERSION: "1.21.4", FABRIC_LAUNCHER_URL: "https://x/y.jar" })
            ).state
        ).toBe("custom");
    });

    it("does not touch plugin servers, whose download API is asked on every start anyway", () => {
        for (const type of ["PAPER", "PURPUR", "VANILLA", "SPIGOT", ""]) {
            expect(loaderPinState(envReader({ TYPE: type, VERSION: "1.21.4" }))).toEqual({ state: "none" });
        }
    });
});

describe("what is written", () => {
    it("holds the incident's server at 21.4.158, read from its own manifest", () => {
        const env = envReader(INCIDENT);
        const spec = loaderToPin(env);
        expect(spec && manifestPath(spec)).toBe("/data/.neoforge-manifest.json");
        expect(pinFromManifest(env, manifest("neoforge"))).toEqual({
            loader: "NeoForge",
            version: "21.4.158",
            vars: { NEOFORGE_VERSION: "21.4.158" }
        });
    });

    it("holds Forge from the same manifest class", () => {
        expect(
            pinFromManifest(envReader({ TYPE: "FORGE", VERSION: "1.20.1" }), manifest("forge"))
        ).toEqual({ loader: "Forge", version: "47.4.0", vars: { FORGE_VERSION: "47.4.0" } });
    });

    it("holds Fabric's loader and, unless somebody chose one, its installer", () => {
        const env = { TYPE: "FABRIC", VERSION: "1.21.4" };
        expect(pinFromManifest(envReader(env), manifest("fabric"))).toEqual({
            loader: "Fabric",
            version: "0.16.10",
            vars: { FABRIC_LOADER_VERSION: "0.16.10", FABRIC_LAUNCHER_VERSION: "1.0.1" }
        });
        expect(
            pinFromManifest(envReader({ ...env, FABRIC_LAUNCHER_VERSION: "1.0.0" }), manifest("fabric"))?.vars
        ).toEqual({ FABRIC_LOADER_VERSION: "0.16.10" });
    });

    it("holds Quilt", () => {
        expect(
            pinFromManifest(envReader({ TYPE: "QUILT", VERSION: "1.21.4" }), manifest("quilt"))?.vars
        ).toEqual({ QUILT_LOADER_VERSION: "0.27.1" });
    });

    it("refuses a manifest written for another release: the server is moving to this one", () => {
        expect(
            pinFromManifest(envReader({ TYPE: "NEOFORGE", VERSION: "1.21.5" }), manifest("neoforge"))
        ).toBeNull();
    });

    it("refuses a manifest that is not one, or carries a version a variable cannot", () => {
        const env = envReader(INCIDENT);
        expect(pinFromManifest(env, "")).toBeNull();
        expect(pinFromManifest(env, "not json")).toBeNull();
        expect(pinFromManifest(env, "[]")).toBeNull();
        expect(
            pinFromManifest(env, JSON.stringify({ minecraftVersion: "1.21.4", forgeVersion: "21.4.158\nX=1" }))
        ).toBeNull();
        expect(
            pinFromManifest(env, JSON.stringify({ minecraftVersion: "1.21.4", forgeVersion: "$(id)" }))
        ).toBeNull();
        expect(pinFromManifest(env, JSON.stringify({ minecraftVersion: "1.21.4" }))).toBeNull();
    });
});

describe("letting it go", () => {
    it("clears the variables that hold it, and only those", () => {
        expect(unpinVars(envReader({ ...INCIDENT, NEOFORGE_VERSION: "21.4.158" }))).toEqual([
            "NEOFORGE_VERSION"
        ]);
        expect(
            unpinVars(
                envReader({
                    TYPE: "FABRIC",
                    VERSION: "1.21.4",
                    FABRIC_LOADER_VERSION: "0.16.10",
                    FABRIC_LAUNCHER_VERSION: "1.0.1"
                })
            )
        ).toEqual(["FABRIC_LOADER_VERSION", "FABRIC_LAUNCHER_VERSION"]);
    });

    it("lets a held loader go when the release moves, so the new release resolves its own", () => {
        const current = envReader({ ...INCIDENT, NEOFORGE_VERSION: "21.4.158" });
        expect(
            loaderReleasedBy(current, envReader({ ...INCIDENT, VERSION: "1.21.5", NEOFORGE_VERSION: "21.4.158" }))
        ).toEqual(["NEOFORGE_VERSION"]);
    });

    it("keeps it when nothing moved, or when the same change names the loader itself", () => {
        const current = envReader({ ...INCIDENT, NEOFORGE_VERSION: "21.4.158" });
        expect(loaderReleasedBy(current, current)).toEqual([]);
        expect(
            loaderReleasedBy(current, envReader({ ...INCIDENT, VERSION: "1.21.5", NEOFORGE_VERSION: "21.5.3" }))
        ).toEqual([]);
        // Nothing held, nothing to let go.
        expect(loaderReleasedBy(envReader(INCIDENT), envReader({ ...INCIDENT, VERSION: "1.21.5" }))).toEqual(
            []
        );
    });
});
