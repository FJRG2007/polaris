/**
 * "Start after" on a kept console command.
 *
 * Pinned: the field is the command's leading `wait N` line and nothing else, so
 * splitting a kept command into the field and the box and joining them back
 * gives the same command; a command kept without one reads back unchanged with
 * an empty field; the field is held to the same range a pause is; and what is
 * joined runs as a pause before the first command.
 */

import { describe, expect, it } from "vitest";
import {
    joinStartDelay,
    keptPress,
    normalizeSavedCommand,
    splitStartDelay,
    startDelayProblem,
    type SavedCommand
} from "@polaris-app/game-servers/src/lib/console-commands";
import {
    LONGEST_WAIT_S,
    MAX_CONSOLE_LINE,
    parseQueue
} from "@polaris-app/game-servers/src/lib/console-queue";
import { english } from "../setup/game-english";

const kept = (command: string): SavedCommand => ({ id: "a", label: "a", command });

describe("the start delay of a kept command", () => {
    it("reads a leading wait into the field and leaves the rest in the box", () => {
        expect(splitStartDelay("wait 10\nsay hi\nsave-all")).toEqual({
            delay: "10",
            body: "say hi\nsave-all"
        });
        expect(splitStartDelay("Wait 2.5s\nsay hi")).toEqual({ delay: "2.5", body: "say hi" });
    });

    it("leaves every command kept without one unchanged, with an empty field", () => {
        for (const command of [
            "say hi",
            "time set day",
            "say a\nwait 10\nsay b",
            "# note\nwait 5\nsay a",
            "/wait 5\nsay a",
            "wait 5",
            "waiting room"
        ]) {
            expect(splitStartDelay(command)).toEqual({ delay: "", body: command });
            expect(joinStartDelay("", splitStartDelay(command).body)).toBe(command);
        }
    });

    it("joins back to the same command it was split from", () => {
        for (const command of [
            "wait 10\nsay hi",
            "wait 0.5\nsay a\nwait 3\nsay b",
            "wait 120\nBroadcast <message>",
            "say hi"
        ]) {
            const { delay, body } = splitStartDelay(command);
            expect(joinStartDelay(delay, body)).toBe(command);
        }
    });

    it("keeps the same pause when the stored line was written another way", () => {
        const command = "WAIT 7s\nsay hi";
        const { delay, body } = splitStartDelay(command);
        expect(parseQueue(joinStartDelay(delay, body), MAX_CONSOLE_LINE)).toEqual(
            parseQueue(command, MAX_CONSOLE_LINE)
        );
    });

    it("adds nothing for an empty or zero delay, or with nothing to run", () => {
        expect(joinStartDelay("", "say hi")).toBe("say hi");
        expect(joinStartDelay(" 0 ", "say hi")).toBe("say hi");
        expect(joinStartDelay("0.0", "say hi")).toBe("say hi");
        expect(joinStartDelay("5", "  ")).toBe("");
        expect(joinStartDelay(" 5 ", " say hi \n\n save-all ")).toBe("wait 5\nsay hi\nsave-all");
    });

    it("takes 0 to the longest pause, and nothing that is not a number", () => {
        for (const ok of ["", "  ", "0", "5", "2.5", String(LONGEST_WAIT_S)]) {
            expect(startDelayProblem(ok)).toBeNull();
        }
        for (const bad of [String(LONGEST_WAIT_S + 1), "-1", "abc", "5s", "1e2", "."]) {
            expect(english(startDelayProblem(bad))).toMatch(/0 to 120 seconds/);
        }
    });

    it("runs as a pause before the first command, single lines included", () => {
        const press = keptPress(kept(joinStartDelay("5", "say hi")), null);
        expect(press).toEqual({
            kind: "queue",
            steps: [
                { kind: "wait", ms: 5000 },
                { kind: "command", line: "say hi" }
            ]
        });
    });

    it("names an unnamed command after its first command, not the pause", () => {
        expect(normalizeSavedCommand({ id: "a", command: "wait 5\nsay hi" })?.label).toBe("say hi");
        expect(normalizeSavedCommand({ id: "a", command: "wait 5" })?.label).toBe("wait 5");
    });
});
