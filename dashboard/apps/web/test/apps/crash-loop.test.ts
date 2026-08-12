/**
 * The rule that tells a boot loop from a slow boot, and the line that says why.
 *
 * Both halves exist because of one real server. It was reset onto a map that pins
 * Minecraft 1.19.4, the settings on its disk had been written by a newer Paper,
 * and 1.19.4 threw while reading them - so it crashed, restarted, and did that
 * forever while the panel said "starting". The log excerpt below is that server's,
 * kept as it came out of the container: thousands of stack frames around one line
 * that matters, which is exactly the shape a parser has to survive.
 */

import { describe, expect, it } from "vitest";
import { crashAdvice, crashCause, crashLoopOf, isConfigCrash, isCrashLooping } from "@/lib/apps/crash-loop";

const NOW = new Date("2026-08-12T21:05:30.000Z");

/** The container as the engine describes one that is looping. */
function looping(over: Partial<Parameters<typeof isCrashLooping>[0]> = {}) {
    return {
        status: "running",
        restartCount: 4,
        startedAt: "2026-08-12T21:05:23.101Z",
        ...over
    };
}

/** Verbatim from the crash, trimmed to the shape rather than the length: the
 *  wrapper exception, its frames, the suppressed siblings, and the root. */
const PAPER_DOWNGRADE = [
    "2026-08-12T21:05:12.645526782Z [21:05:12 ERROR]: Encountered an unexpected exception",
    "2026-08-12T21:05:12.645530667Z org.spongepowered.configurate.serialize.SerializationException: [entities, spawning, monster-spawn-max-light-level] of type java.lang.Integer: java.lang.NumberFormatException: For input string: \"default\"",
    "2026-08-12T21:05:12.645533266Z     at org.spongepowered.configurate.serialize.NumericSerializers.parseNumber(NumericSerializers.java:346) ~[configurate-core-4.1.2.jar:?]",
    "2026-08-12T21:05:12.645535578Z     at io.papermc.paper.configuration.Configurations.initializeWorldDefaultsConfiguration(Configurations.java:154) ~[paper-1.19.4.jar:git-Paper-550]",
    "2026-08-12T21:05:12.645588582Z     at java.lang.Thread.run(Unknown Source) ~[?:?]",
    "2026-08-12T21:05:12.645590527Z     Suppressed: org.spongepowered.configurate.serialize.SerializationException: [misc, max-leash-distance] of type java.lang.Float: java.lang.NumberFormatException: For input string: \"default\"",
    "2026-08-12T21:05:12.645598269Z         at org.spongepowered.configurate.serialize.FunctionScalarSerializer.deserialize(FunctionScalarSerializer.java:40) ~[configurate-core-4.1.2.jar:?]",
    "2026-08-12T21:05:12.645705198Z         ... 19 more",
    "2026-08-12T21:05:12.645710961Z Caused by: java.lang.NumberFormatException: For input string: \"default\"",
    "2026-08-12T21:05:12.645712923Z     at java.lang.NumberFormatException.forInputString(Unknown Source) ~[?:?]",
    "2026-08-12T21:05:12.645718782Z     ... 20 more",
    "2026-08-12T21:05:12.648865749Z [21:05:12 ERROR]: This crash report has been saved to: /data/./crash-reports/crash-2026-08-12_21.05.12-server.txt",
    "2026-08-12T21:05:12.649407544Z [21:05:12 INFO]: Stopping server"
].join("\n");

describe("whether a container is looping", () => {
    it("says no to a first boot that is simply taking its time", () => {
        // The case this rule exists to not break: the image fetching its own jar
        // and every plugin takes real minutes, and it has restarted nothing.
        expect(isCrashLooping(looping({ restartCount: 0 }), NOW)).toBe(false);
    });

    it("says no to a server that looped a long time ago and settled", () => {
        // The count is cumulative for the container's whole life, so without the
        // clock beside it every server that ever had a bad week reads as broken.
        expect(isCrashLooping(looping({ startedAt: "2026-08-10T09:00:00.000Z" }), NOW)).toBe(false);
    });

    it("says no to one restart, which is somebody pressing the button", () => {
        expect(isCrashLooping(looping({ restartCount: 1 }), NOW)).toBe(false);
    });

    it("says yes to restarts piling up on a run that is seconds old", () => {
        expect(isCrashLooping(looping(), NOW)).toBe(true);
    });

    it("takes the engine's own word for it when the poll lands in the backoff", () => {
        expect(isCrashLooping({ status: "restarting", restartCount: 1, restarting: true }, NOW)).toBe(true);
    });

    it("does not convict on a count with no start time to read it against", () => {
        expect(isCrashLooping({ status: "running", restartCount: 9 }, NOW)).toBe(false);
        expect(isCrashLooping(looping({ startedAt: "0001-01-01T00:00:00Z" }), NOW)).toBe(false);
    });
});

describe("what the log says went wrong", () => {
    it("returns the root cause rather than the exception wrapping it", () => {
        // Java prints the outer failure first and each cause under the last, so
        // the deepest one is the answer. "Failed to initialize world defaults" is
        // true and useless; the input string is the half somebody can act on.
        expect(crashCause(PAPER_DOWNGRADE)).toBe('NumberFormatException: For input string: "default"');
    });

    it("never returns a stack frame", () => {
        const cause = crashCause(PAPER_DOWNGRADE) ?? "";
        expect(cause.startsWith("at ")).toBe(false);
        expect(cause).not.toContain(".jar:");
    });

    it("drops the timestamps and the level the line arrived wearing", () => {
        const cause = crashCause(PAPER_DOWNGRADE) ?? "";
        expect(cause).not.toContain("2026-08-12T");
        expect(cause).not.toContain("ERROR");
    });

    it("falls back to the last error line for a crash that is not Java", () => {
        const ark = ["Setting breakpad minidump AppID = 2430930", "Fatal error: could not open PrimalGameData"].join(
            "\n"
        );
        expect(crashCause(`${ark}\nERROR: Shutdown handler: initiate app exit`)).toContain("Shutdown handler");
    });

    it("says nothing about a server that is running fine", () => {
        const healthy = ['[12:00:00 INFO]: Done (21.5s)! For help, type "help"', "[12:00:04 INFO]: Alice joined"].join(
            "\n"
        );
        expect(crashCause(healthy)).toBeNull();
    });
});

describe("what to do about it", () => {
    it("names the fix for settings a newer release wrote", () => {
        const advice = crashAdvice('NumberFormatException: For input string: "default"');
        expect(advice).toContain("newer Minecraft");
    });

    it("stays quiet about a crash it does not recognise", () => {
        expect(crashAdvice("IllegalStateException: something nobody has seen before")).toBeNull();
    });

    it("reads a whole loop in one go", () => {
        const loop = crashLoopOf(looping(), PAPER_DOWNGRADE);
        expect(loop.restarts).toBe(4);
        expect(loop.cause).toContain("NumberFormatException");
        expect(loop.advice).toContain("newer Minecraft");
    });
});

describe("the crash a folder move fixes", () => {
    it("recognises the settings written by a newer release", () => {
        // The screen offers its recovery button on exactly this, so the rule lives
        // in one place rather than being spelled twice and drifting apart.
        expect(isConfigCrash('NumberFormatException: For input string: "default"')).toBe(true);
    });

    it("does not claim to fix anything else", () => {
        expect(isConfigCrash("OutOfMemoryError: Java heap space")).toBe(false);
        expect(isConfigCrash('NumberFormatException: For input string: "seven"')).toBe(false);
        expect(isConfigCrash(null)).toBe(false);
    });
});
