/**
 * The Java a Minecraft server's container runs.
 *
 * Both ways of getting it wrong were seen on a real server: Minecraft 26.x
 * exits at startup on Java 21 ("requires running the server with Java 25"), and
 * NeoForge 1.21.4 dies on Java 25 (`Module jdk.crypto.ec not found`). `LATEST`
 * resolves to 26.x on every server software.
 */

import { describe, expect, it } from "vitest";
import {
    javaTagFor,
    minecraftImageFor,
    minecraftReleaseEnv
} from "@polaris-app/game-servers/src/lib/minecraft/runtime";

describe("the runtime a release needs", () => {
    it("is Java 25 from 26.x, and for LATEST, snapshots and the image's default", () => {
        for (const version of [
            "26.1",
            "26.2",
            "27.0",
            "LATEST",
            "latest",
            " LATEST ",
            "",
            "SNAPSHOT",
            "26w14a"
        ]) {
            expect(javaTagFor(version), version).toBe("java25");
        }
    });

    it("is Java 21 for the 1.x line and anything it cannot read", () => {
        for (const version of ["1.21.4", "1.20.6", "1.16.5", "1.21.4-pre1", "21w13a", "custom"]) {
            expect(javaTagFor(version), version).toBe("java21");
        }
    });
});

describe("the image a server deploys", () => {
    const managed = "itzg/minecraft-server:java21";

    it("follows the server's VERSION", () => {
        expect(minecraftImageFor(managed, { VERSION: "LATEST" })).toBe(
            "itzg/minecraft-server:java25"
        );
        expect(minecraftImageFor("itzg/minecraft-server:java25", { VERSION: "1.21.4" })).toBe(
            "itzg/minecraft-server:java21"
        );
        expect(minecraftImageFor(managed, {})).toBe("itzg/minecraft-server:java25");
    });

    it("leaves any other image alone, including one pinned by hand", () => {
        expect(minecraftImageFor("itzg/minecraft-server:java17", { VERSION: "LATEST" })).toBe(
            "itzg/minecraft-server:java17"
        );
        expect(
            minecraftImageFor("itzg/minecraft-server:2026.9.1-java21", { VERSION: "LATEST" })
        ).toBe("itzg/minecraft-server:2026.9.1-java21");
        expect(minecraftImageFor("nginx:1.27", { VERSION: "LATEST" })).toBe("nginx:1.27");
        expect(minecraftImageFor(undefined, { VERSION: "LATEST" })).toBeUndefined();
    });
});

describe("the settings every Minecraft Java server runs with", () => {
    it("keep RCON out of the ops' chat on any tag of the image", () => {
        for (const image of [
            "itzg/minecraft-server:java21",
            "itzg/minecraft-server:java25",
            "itzg/minecraft-server:2026.9.1-java21",
            "docker.io/itzg/minecraft-server:latest",
            "itzg/minecraft-server"
        ]) {
            expect(minecraftReleaseEnv(image), image).toEqual({ BROADCAST_RCON_TO_OPS: "false" });
        }
    });

    it("are nothing for any other image", () => {
        for (const image of ["nginx:1.27", "itzg/minecraft-bedrock-server:latest", "", undefined]) {
            expect(minecraftReleaseEnv(image), String(image)).toBeUndefined();
        }
    });
});
