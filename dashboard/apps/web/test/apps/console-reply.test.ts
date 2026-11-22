/**
 * Reading a console answer for a refusal, and what a scheduled run shows.
 *
 * Pinned: a Java server's refusal - the `<--[HERE]` marker or one of the
 * answers it starts a refused line with - reads as failed, an ordinary answer
 * and every other game's answer do not; a run is failed by any refused line,
 * with the server's text; a run still marked running long after any run could
 * end reads as cut short; and the pauses a scheduled run may hold are bounded.
 */

import { describe, expect, it } from "vitest";
import {
    isMinecraftRefusal,
    isRefusedReply
} from "@polaris-app/game-servers/src/lib/minecraft/console-reply";
import {
    MOST_SCHEDULED_WAIT_S,
    scheduledWaitProblem,
    shownRun,
    totalWaitMs
} from "@polaris-app/game-servers/src/lib/console-schedule";
import { english } from "../setup/game-english";
import { scheduleProblem } from "@polaris-app/game-servers/src/lib/console-commands";

describe("a Java server's answer", () => {
    it("reads the refusals the game answers in words", () => {
        for (const refusal of [
            "Invalid or unknown entity type 'feralzombie:predator'\n...@e[type=feralzombie:predator]<--[HERE]",
            "Unknown or incomplete command, see below for error\ntp @a ~ ~ ~ x<--[HERE]",
            "Incorrect argument for command\n...me give<--[HERE]",
            "No entity was found",
            "No player was found",
            "...ive @s stone 99999<--[HERE]"
        ]) {
            expect(isMinecraftRefusal(refusal)).toBe(true);
        }
    });

    it("takes an ordinary answer, or none, as it stands", () => {
        for (const answer of [
            "",
            "Set the time to 1000",
            "Teleported Ada to 0.5, 64.0, 0.5",
            "[Server] No entity was found here, says Ada",
            "There are 0 of a max of 20 players online:"
        ]) {
            expect(isMinecraftRefusal(answer)).toBe(false);
        }
    });

    it("reads only a Java server's answers", () => {
        expect(isRefusedReply("java", "No player was found")).toBe(true);
        expect(isRefusedReply("bedrock", "No player was found")).toBe(false);
        expect(isRefusedReply(null, "x<--[HERE]")).toBe(false);
    });
});

describe("what a scheduled run shows", () => {
    const at = "2026-10-11T12:00:00.000Z";

    it("keeps a finished run as it was written", () => {
        const ran = { at, outcome: "ran", detail: "" } as const;
        expect(shownRun(ran, new Date("2027-01-01T00:00:00.000Z"))).toBe(ran);
    });

    it("shows a run with pauses as running while it can still be", () => {
        const running = { at, outcome: "running", detail: "" } as const;
        expect(shownRun(running, new Date("2026-10-11T12:05:00.000Z"))).toBe(running);
    });

    it("shows one still running long after any run could end as cut short", () => {
        const shown = shownRun(
            { at, outcome: "running", detail: "" },
            new Date("2026-10-11T13:00:00.000Z")
        );
        expect(shown.outcome).toBe("failed");
        expect(english(shown.detail)).toBe("The run was cut short before it finished.");
    });
});

describe("the pauses a scheduled run may hold", () => {
    it("adds up its waits", () => {
        expect(
            totalWaitMs([
                { kind: "wait", ms: 5000 },
                { kind: "command", line: "say a" },
                { kind: "wait", ms: 2500 }
            ])
        ).toBe(7500);
    });

    it("allows up to the bound in all, and refuses more", () => {
        const wait = (seconds: number) => ({ kind: "wait", ms: seconds * 1000 }) as const;
        expect(scheduledWaitProblem([wait(MOST_SCHEDULED_WAIT_S)])).toBeNull();
        expect(english(scheduledWaitProblem([wait(MOST_SCHEDULED_WAIT_S), wait(1)]))).toMatch(
            /600 seconds in all/
        );
    });

    it("lets a kept command with a few pauses, or a Start after, be scheduled", () => {
        expect(scheduleProblem("say hi")).toBeNull();
        expect(scheduleProblem("wait 5\nsay hi\nwait 5\nsay done")).toBeNull();
        const long = Array.from({ length: 6 }, (_, at) => `say ${at}\nwait 120`).join("\n");
        expect(scheduleProblem(long)).not.toBeNull();
    });
});
