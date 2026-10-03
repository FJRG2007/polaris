/**
 * A server that crash-loops because it cannot download its own software.
 *
 * The log below is reconstructed from the incident of 2026-10-03 - the excerpt
 * the operator saw, laid out the way the image prints it: the helper's
 * `[mc-image-helper] HH:mm:ss.SSS LEVEL : msg` lines (its logback pattern), the
 * exception the helper logged with its trace, and the init script's own line.
 * What matters is the shape: the root cause is a parser refusing a field, three
 * frames down, under a line that names the command.
 */

import { describe, expect, it } from "vitest";
import {
    crashLoopOf,
    isConfigCrash,
    isLoaderCrash,
    loaderCrashOf,
    loaderInstallFailure
} from "@polaris-app/game-servers/src/lib/crash-loop";
import { english } from "../setup/game-english";

const LOOPING = { status: "running", restartCount: 9, startedAt: "2026-10-03T17:19:30.000Z" };

const NEOFORGE_METADATA = [
    "2026-10-03T17:19:30.101Z [init] Running as uid=1000 gid=1000 with /data as 'drwxrwxr-x 9 1000 1000 4096 Oct  3 17:19 /data'",
    "2026-10-03T17:19:30.512Z [init] Resolving type given NEOFORGE",
    "2026-10-03T17:19:31.818Z [mc-image-helper] 17:19:31.818 ERROR : 'install-neoforge' command failed. Version is 1.70.2",
    "2026-10-03T17:19:31.818Z me.itzg.helpers.errors.GenericException: Failed to parse response body into class me.itzg.helpers.mvn.MavenMetadata",
    "2026-10-03T17:19:31.819Z \tat me.itzg.helpers.http.ObjectFetchBuilder.lambda$assemble$0(ObjectFetchBuilder.java:57)",
    "2026-10-03T17:19:31.819Z \tat reactor.core.publisher.FluxMapFuseable$MapFuseableSubscriber.onNext(FluxMapFuseable.java:113)",
    '2026-10-03T17:19:31.820Z Caused by: com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException: Unrecognized field "modelVersion" (class me.itzg.helpers.mvn.MavenMetadata), not marked as ignorable (3 known properties: "versioning", "groupId", "artifactId"])',
    "2026-10-03T17:19:31.820Z \tat com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException.from(UnrecognizedPropertyException.java:61)",
    "2026-10-03T17:19:31.820Z \t... 31 more",
    "2026-10-03T17:19:31.901Z [init] Failed to install NeoForge"
].join("\n");

/** The same command failing because nothing answered: logged on one line, no
 *  trace (`logExceptionWithoutStacktrace`). */
const NEOFORGE_UNREACHABLE = [
    "2026-10-03T17:19:30.512Z [init] Resolving type given NEOFORGE",
    "2026-10-03T17:19:41.818Z [mc-image-helper] 17:19:41.818 ERROR : 'install-neoforge' command failed. Version is 1.70.2: Connection refused: maven.neoforged.net/192.0.2.10:443",
    "2026-10-03T17:19:41.901Z [init] Failed to install NeoForge"
].join("\n");

describe("telling it apart", () => {
    it("names the command and the reason, not a library's line", () => {
        const loop = crashLoopOf(LOOPING, NEOFORGE_METADATA);
        expect(loop.cause).toMatch(/^'install-neoforge' command failed: UnrecognizedPropertyException: Unrecognized field "modelVersion"/);
        // Cut to a status card's length, the way every cause is.
        expect(loop.cause!.endsWith("...")).toBe(true);
        expect(loop.cause!.length).toBeLessThanOrEqual(202);
        expect(loaderInstallFailure(NEOFORGE_METADATA)).toBe("install-neoforge");
    });

    it("says the repository answered in a format the image cannot read", () => {
        const loop = crashLoopOf(LOOPING, NEOFORGE_METADATA);
        expect(loaderCrashOf(loop.cause)).toEqual({
            installer: "install-neoforge",
            name: "NeoForge",
            unreadable: true
        });
        expect(english(loop.advice)).toBe(
            "The loader could not be downloaded: NeoForge's repository answered in a format the image cannot read."
        );
    });

    it("says the repository did not answer when that is what happened", () => {
        const loop = crashLoopOf(LOOPING, NEOFORGE_UNREACHABLE);
        expect(loop.cause).toBe(
            "'install-neoforge' command failed. Version is 1.70.2: Connection refused: maven.neoforged.net/192.0.2.10:443"
        );
        expect(english(loop.advice)).toBe(
            "The loader could not be downloaded: NeoForge's repository did not answer."
        );
    });

    it("offers the loader fix on these and only these", () => {
        expect(isLoaderCrash(crashLoopOf(LOOPING, NEOFORGE_METADATA).cause)).toBe(true);
        expect(isConfigCrash(crashLoopOf(LOOPING, NEOFORGE_METADATA).cause)).toBe(false);
        expect(isLoaderCrash('NumberFormatException: For input string: "default"')).toBe(false);
        expect(isLoaderCrash(null)).toBe(false);
        // A command the helper runs that is not a server's software.
        expect(isLoaderCrash("'mcopy' command failed. Version is 1.70.2")).toBe(false);
    });

    it("forgets a failure the server has since started past", () => {
        const recovered = `${NEOFORGE_METADATA}\n2026-10-03T17:40:12.000Z [17:40:12 INFO]: Done (8.412s)! For help, type "help"`;
        expect(loaderInstallFailure(recovered)).toBeNull();
        expect(isLoaderCrash(crashLoopOf(LOOPING, recovered).cause)).toBe(false);
    });
});
