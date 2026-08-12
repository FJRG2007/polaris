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
import {
    crashAdvice,
    crashCause,
    crashLoopOf,
    isConfigCrash,
    isCrashLooping,
    reachedReady,
    watchesRestarts
} from "@/lib/apps/crash-loop";

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

/** What the sweep saw a minute ago. */
function seen(restartCount: number) {
    return { restartCount, at: "2026-08-12T21:04:30.000Z" };
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

/**
 * The other real one: the same server a few minutes later, after the settings were
 * set aside. It is the log of a server that recovered - the old run being stopped,
 * a new one, and a clean start - except that the loudest thing in it is Polaris's
 * own `list` poll hitting a server with no main thread to run it on. Read naively
 * it says the server died of "Asynchronous command dispatch", which is a question
 * Polaris asked rather than anything that went wrong.
 */
const RECOVERED = [
    '2026-08-12T22:44:17.743056344Z [22:44:17 WARN]: Unexpected exception while parsing console command "list"',
    "2026-08-12T22:44:17.743073104Z java.lang.IllegalStateException: Asynchronous command dispatch!",
    "2026-08-12T22:44:17.743076622Z     at org.spigotmc.AsyncCatcher.catchOp(AsyncCatcher.java:16) ~[paper-1.19.4.jar:git-Paper-550]",
    "2026-08-12T22:44:17.743116649Z [22:44:17 INFO]: Thread RCON Client /0:0:0:0:0:0:0:1 shutting down",
    "2026-08-12T22:44:18.269346032Z [22:44:18 INFO]: Flushing Chunk IO",
    "2026-08-12T22:44:19.394568977Z 2026-08-12T22:44:19.394Z    WARN    mc-server-runner    Minecraft server failed. Inspect logs above for errors that indicate cause. DO NOT report this line as an error.    {\"exitCode\": 1}",
    "2026-08-12T22:44:20.277006455Z [init] Running as uid=1000 gid=1000 with /data as 'drwxr-x--- 26 1000 1000 4096 Aug 12 22:40 /data'",
    "2026-08-12T22:44:24.994008348Z [init] Copying any configs from /config to /data/config",
    "2026-08-12T22:44:30.117935685Z [init] Starting the Minecraft server...",
    "2026-08-12T22:44:34.535323238Z [22:44:34 INFO]: Starting minecraft server version 1.19.4",
    '2026-08-12T22:44:38.720204272Z [22:44:38 INFO]: Done (4.193s)! For help, type "help"',
    "2026-08-12T22:44:39.114781013Z [22:44:39 INFO]: [BedWars1058] Loading internal Party system. /party"
].join("\n");

describe("whether a container is worth watching", () => {
    it("says no to a first boot that is simply taking its time", () => {
        // The case this rule exists to not break: the image fetching its own jar
        // and every plugin takes real minutes, and it has restarted nothing.
        expect(watchesRestarts(looping({ restartCount: 0 }), NOW)).toBe(false);
    });

    it("says no to a server that looped a long time ago and settled", () => {
        // The count is cumulative for the container's whole life, so without the
        // clock beside it every server that ever had a bad week reads as broken.
        expect(watchesRestarts(looping({ startedAt: "2026-08-10T09:00:00.000Z" }), NOW)).toBe(false);
    });

    it("says no to one restart, which is somebody pressing the button", () => {
        expect(watchesRestarts(looping({ restartCount: 1 }), NOW)).toBe(false);
    });

    it("says yes to restarts piling up on a run that is seconds old", () => {
        expect(watchesRestarts(looping(), NOW)).toBe(true);
    });

    it("takes the engine's own word for it when the poll lands in the backoff", () => {
        expect(watchesRestarts({ status: "restarting", restartCount: 4, restarting: true }, NOW)).toBe(true);
    });

    it("does not suspect a count with no start time to read it against", () => {
        expect(watchesRestarts({ status: "running", restartCount: 9 }, NOW)).toBe(false);
        expect(watchesRestarts(looping({ startedAt: "0001-01-01T00:00:00Z" }), NOW)).toBe(false);
    });
});

describe("whether a container is looping", () => {
    it("waits for a second reading rather than convicting on the first", () => {
        expect(isCrashLooping(looping(), null, NOW)).toBe(false);
    });

    it("leaves alone a server that looped, was fixed, and is seconds into a good run", () => {
        // This is the bug as it happened, and it cost a working server. The count
        // never resets, and the run that finally worked began the moment the last
        // failed one died - so a recovered container carries a high count and a
        // young start time, which is the same shape as one still going round. The
        // count standing still is the whole difference.
        expect(isCrashLooping(looping({ restartCount: 12 }), seen(12), NOW)).toBe(false);
    });

    it("does not read one restart as a loop", () => {
        expect(isCrashLooping(looping({ restartCount: 13 }), seen(12), NOW)).toBe(false);
    });

    it("says yes once the count is still climbing a minute later", () => {
        expect(isCrashLooping(looping({ restartCount: 20 }), seen(12), NOW)).toBe(true);
    });

    it("survives a container that was rebuilt under it", () => {
        // A redeploy makes a new container, whose count starts at zero. The old
        // reading is then larger than the new one, which is not evidence of
        // anything at all.
        expect(isCrashLooping(looping({ restartCount: 1 }), seen(12), NOW)).toBe(false);
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

    it("never blames the crash on Polaris asking who is online", () => {
        // Every few seconds, for as long as the server is not answering, and always
        // the last thing in the log. Reading it back as the cause of death told a
        // real operator their server died of a command Polaris sent it. Tested
        // without the recovery around it, so it is the filter answering and not the
        // rule that drops everything before a successful start.
        const noise = RECOVERED.split("\n").slice(0, 4).join("\n");
        expect(crashCause(`${PAPER_DOWNGRADE}\n${noise}`)).toContain("NumberFormatException");
        expect(crashCause(noise)).toBeNull();
    });

    it("has nothing to say about a server that got up on this run", () => {
        // The crash before last is still in a tail long enough to hold a stack
        // trace, and it describes a run that is over.
        expect(crashCause(RECOVERED)).toBeNull();
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

/**
 * A third real one, and the nastiest: the server starts perfectly, announces it is
 * up, and dies five seconds later when a plugin loads a world from an earlier life
 * that a newer Minecraft had written. It restarts and does the whole thing again.
 */
const UP_THEN_DEAD = [
    '2026-08-12T23:28:25.041623079Z [23:28:25 INFO]: Done (4.367s)! For help, type "help"',
    "2026-08-12T23:28:29.934479887Z [23:28:29 INFO]: [BedWars1058] This server is running in MULTIARENA with auto-scale false",
    "2026-08-12T23:28:30.016095484Z [23:28:30 INFO]: Preparing start region for dimension minecraft:world-20260812-023456",
    "2026-08-12T23:28:30.024533912Z [23:28:30 WARN]: java.lang.RuntimeException: Server attempted to load chunk saved with newer version of minecraft! 4189 > 3337",
    "2026-08-12T23:28:30.024562356Z [23:28:30 WARN]:     at net.minecraft.world.level.chunk.storage.ChunkRegionLoader.loadChunk(ChunkRegionLoader.java:154)",
    "2026-08-12T23:28:30.032931627Z [23:28:30 INFO]: Stopping server",
    "2026-08-12T23:28:30.033359552Z [23:28:30 INFO]: [BedWars1058] Disabling BedWars1058 v25.5-SNAPSHOT",
    '2026-08-12T23:28:30.797351845Z [23:28:30 WARN]: Unexpected exception while parsing console command "list"',
    "2026-08-12T23:28:30.797358262Z java.lang.IllegalStateException: Asynchronous command dispatch!"
].join("\n");

describe("a server that starts and then dies", () => {
    it("is not counted as having got up", () => {
        // The reading that would otherwise call off the whole check. A "Done" line
        // proves the server started, not that it is still running, and a server
        // that crashes eight seconds in loops exactly as forever as one that never
        // starts at all.
        expect(reachedReady(UP_THEN_DEAD)).toBe(false);
    });

    it("is explained by what killed it rather than by what it printed last", () => {
        const cause = crashCause(UP_THEN_DEAD) ?? "";
        expect(cause).toContain("newer version of minecraft");
        expect(cause).not.toContain("Asynchronous command dispatch");
    });

    it("says what a world from a newer release means", () => {
        expect(crashAdvice(crashCause(UP_THEN_DEAD) ?? "")).toContain("newer Minecraft");
    });
});

describe("whether the server got up", () => {
    it("recognises the run that finally worked", () => {
        expect(reachedReady(RECOVERED)).toBe(true);
    });

    it("does not count a start that a later boot has already replaced", () => {
        // The same log with one more restart on the end: the server was up, and
        // then it was not, and what matters is the run it is on now.
        expect(reachedReady(`${RECOVERED}\n2026-08-12T22:45:01.0Z [init] Running as uid=1000 gid=1000`)).toBe(false);
    });

    it("does not claim a crashing server got anywhere", () => {
        expect(reachedReady(PAPER_DOWNGRADE)).toBe(false);
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
