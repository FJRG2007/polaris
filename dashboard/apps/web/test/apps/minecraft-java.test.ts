/**
 * The runtime a Minecraft server is given, which is chosen by the image tag and
 * by nothing else.
 *
 * `itzg/minecraft-server:latest` is Java 25, and Java 25 removed the
 * `jdk.crypto.ec` module. Minecraft's authlib depends on nimbus-jose-jwt, whose
 * module-info requires that module by name, so any launch that resolves a module
 * graph - which is what Forge and NeoForge do through BootstrapLauncher - fails
 * before a mod is loaded:
 *
 *   Exception in thread "main" java.lang.module.FindException:
 *   Module jdk.crypto.ec not found, required by com.nimbusds.jose.jwt
 *
 * What that looks like from the outside is a server that restarts nine times and
 * stops, with a stack trace naming a module nobody configured. It is not a mod
 * conflict and no change to the mod list can fix it.
 *
 * The image takes no environment variable for the runtime: the Java version IS
 * the tag. So the tag is the fix, and it is asserted here because `latest` is
 * exactly the kind of value somebody tidies back in later.
 */

import { findApp } from "@/lib/apps/catalog";
import { minecraftImageFor } from "@/lib/apps/minecraft/runtime";
import { describe, expect, it } from "vitest";

describe("the Minecraft server's image", () => {
    const minecraft = findApp("minecraft");

    it("exists and is installed from a template", () => {
        expect(minecraft?.template?.image).toBeTruthy();
    });

    it("names a Java tag the deploy knows how to swap", () => {
        // Minecraft 26.x needs Java 25 and the 1.21 line's mod loaders cannot run
        // on it, so every deploy picks the tag from VERSION - but only when the
        // stored image is one of the tags it manages (`minecraft-runtime.test.ts`).
        expect(minecraftImageFor(minecraft?.template?.image, { VERSION: "LATEST" })).toBe(
            "itzg/minecraft-server:java25"
        );
        expect(minecraftImageFor(minecraft?.template?.image, { VERSION: "1.21.4" })).toBe(
            "itzg/minecraft-server:java21"
        );
    });

    it("never floats on latest", () => {
        // `latest` is whatever Java the image ships today, which is how a server
        // that booted last month stops booting after an image refresh nobody
        // asked for.
        expect(minecraft?.template?.image).not.toContain(":latest");
    });
});
