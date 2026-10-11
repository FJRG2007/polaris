/**
 * The loader versions a server can be moved to, read off the loaders' own
 * repositories. The bodies here are trimmed copies of what each repository
 * answers (Fabric and Quilt meta, NeoForge's maven API, Forge's
 * maven-metadata.json), so a change in the parsing is checked against the
 * shapes it has to read.
 */

import { describe, expect, it } from "vitest";
import {
    loaderVersionsFrom,
    neoforgePrefix
} from "@polaris-app/game-servers/src/lib/minecraft/loader-versions";
import {
    chosenLoaderVars,
    envReader,
    loaderChoiceOf
} from "@polaris-app/game-servers/src/lib/minecraft/loader-pin";

describe("NeoForge's number for a release", () => {
    it("drops the leading 1 of the old releases and pads to two places", () => {
        expect(neoforgePrefix("1.21.4")).toBe("21.4.");
        expect(neoforgePrefix("1.21")).toBe("21.0.");
    });

    it("keeps the year-numbered releases, to three places", () => {
        expect(neoforgePrefix("26.3")).toBe("26.3.0.");
        expect(neoforgePrefix("26.1.2")).toBe("26.1.2.");
    });

    it("has none for anything that is not a release", () => {
        expect(neoforgePrefix("LATEST")).toBeNull();
        expect(neoforgePrefix("1.21.4-pre1")).toBeNull();
    });
});

describe("the versions each repository lists", () => {
    it("reads Fabric's and Quilt's meta, newest first by number", () => {
        const body = [
            { loader: { version: "0.16.9", stable: true } },
            { loader: { version: "0.16.10", stable: true } },
            { loader: { version: "0.15.11", stable: true } }
        ];
        expect(loaderVersionsFrom("FABRIC", "1.21.4", body)).toEqual([
            "0.16.10",
            "0.16.9",
            "0.15.11"
        ]);
        expect(loaderVersionsFrom("QUILT", "1.21.4", body)).toHaveLength(3);
    });

    it("keeps only NeoForge's builds for the release", () => {
        const body = {
            isSnapshot: false,
            versions: ["21.3.58", "21.4.150", "21.4.158", "21.4.9-beta", "26.3.0.69-beta"]
        };
        expect(loaderVersionsFrom("NEOFORGE", "1.21.4", body)).toEqual([
            "21.4.158",
            "21.4.150",
            "21.4.9-beta"
        ]);
        expect(loaderVersionsFrom("NEOFORGE", "26.3", body)).toEqual(["26.3.0.69-beta"]);
    });

    it("gives Forge's builds without the release in front", () => {
        const body = {
            "1.20.1": ["1.20.1-47.4.24", "1.20.1-47.4.26", "1.20.1-47.4.25"],
            "1.21.1": ["1.21.1-52.0.1"]
        };
        expect(loaderVersionsFrom("FORGE", "1.20.1", body)).toEqual([
            "47.4.26",
            "47.4.25",
            "47.4.24"
        ]);
        expect(loaderVersionsFrom("FORGE", "1.19.2", body)).toEqual([]);
    });

    it("lists nothing for an answer that is not the repository's shape", () => {
        expect(loaderVersionsFrom("FABRIC", "1.21.4", { error: "nope" })).toEqual([]);
        expect(loaderVersionsFrom("NEOFORGE", "1.21.4", "<html>")).toEqual([]);
        expect(loaderVersionsFrom("FORGE", "1.20.1", null)).toEqual([]);
    });

    it("drops a version that could not go into a variable as it is", () => {
        const body = [{ loader: { version: "0.16.10" } }, { loader: { version: "0.1;rm -rf" } }];
        expect(loaderVersionsFrom("FABRIC", "1.21.4", body)).toEqual(["0.16.10"]);
    });
});

describe("choosing a loader version", () => {
    it("is offered on a held or following loader on an exact release", () => {
        expect(
            loaderChoiceOf(
                envReader({ TYPE: "NEOFORGE", VERSION: "1.21.4", NEOFORGE_VERSION: "21.4.158" })
            )
        ).toEqual({ type: "NEOFORGE", loader: "NeoForge", minecraft: "1.21.4" });
        expect(loaderChoiceOf(envReader({ TYPE: "FABRIC", VERSION: "1.21.4" }))).toEqual({
            type: "FABRIC",
            loader: "Fabric",
            minecraft: "1.21.4"
        });
    });

    it("is not offered without a release, a loader, or on an installer of the operator's", () => {
        expect(loaderChoiceOf(envReader({ TYPE: "FABRIC", VERSION: "LATEST" }))).toBeNull();
        expect(
            loaderChoiceOf(
                envReader({ TYPE: "NEOFORGE", VERSION: "LATEST", NEOFORGE_VERSION: "21.4.158" })
            )
        ).toBeNull();
        expect(loaderChoiceOf(envReader({ TYPE: "PAPER", VERSION: "1.21.4" }))).toBeNull();
        expect(
            loaderChoiceOf(
                envReader({ TYPE: "FORGE", VERSION: "1.20.1", FORGE_INSTALLER: "/data/x.jar" })
            )
        ).toBeNull();
    });

    it("writes the main variable and empties an older spelling the image would read", () => {
        expect(
            chosenLoaderVars(
                envReader({ TYPE: "FORGE", VERSION: "1.20.1", FORGEVERSION: "47.4.0" }),
                "47.4.26"
            )
        ).toEqual({ FORGE_VERSION: "47.4.26", FORGEVERSION: "" });
        expect(
            chosenLoaderVars(envReader({ TYPE: "FABRIC", VERSION: "1.21.4" }), " 0.16.10 ")
        ).toEqual({ FABRIC_LOADER_VERSION: "0.16.10" });
    });

    it("refuses what is not a version, or means newest again", () => {
        const env = envReader({ TYPE: "NEOFORGE", VERSION: "1.21.4" });
        expect(chosenLoaderVars(env, "latest")).toBeNull();
        expect(chosenLoaderVars(env, "21.4.1\nX=1")).toBeNull();
        expect(chosenLoaderVars(envReader({ TYPE: "PAPER" }), "1")).toBeNull();
    });
});
