/**
 * The live console's text (`lib/console-stream.ts`).
 *
 * Pinned: output split anywhere is written whole lines at a time, its docker
 * stamp shortened to the time of day; a polled read adds only what is new; and
 * the prompt edits a line from keys and hands over whole lines on Enter, with
 * the arrows walking the past commands like a shell.
 */

import { describe, expect, it } from "vitest";
import {
    CONSOLE_PROMPT,
    EMPTY_LINE,
    consoleRow,
    createConsoleOutput,
    editLine,
    newSince,
    replyRows
} from "@polaris-app/game-servers/src/lib/console-stream";

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("console output", () => {
    it("shortens the stamp and ends the row for a terminal", () => {
        expect(plain(consoleRow("2026-11-25T10:00:00.123456789Z [Server] Done"))).toBe("10:00:00 [Server] Done\r\n");
        expect(consoleRow("no stamp here")).toBe("no stamp here\r\n");
    });

    it("holds a line split across chunks until it is whole", () => {
        const output = createConsoleOutput();
        expect(output.push("2026-11-25T10:00:00Z Steve jo")).toBe("");
        expect(plain(output.push("ined the game\n2026-11-25T10:00:01Z next"))).toBe(
            "10:00:00 Steve joined the game\r\n"
        );
        expect(output.log()).toBe("2026-11-25T10:00:00Z Steve joined the game");
    });

    it("adds only what a polled read has that the last did not", () => {
        expect(newSince("", "a\nb")).toBe("a\nb");
        expect(newSince("a\nb", "a\nb\nc\nd")).toBe("c\nd");
        expect(newSince("a\nb", "a\nb")).toBe("");
        expect(newSince("x\ny", "a\nb")).toBe("a\nb");
    });

    it("writes a failed answer in red under the command", () => {
        const rows = replyRows("op Steve", "Unknown player", true);
        expect(plain(rows)).toBe(`${CONSOLE_PROMPT}op Steve\r\nUnknown player\r\n`);
        expect(rows).toContain("\x1b[31m");
    });
});

describe("the prompt", () => {
    it("echoes what is typed and sends the line on Enter", () => {
        const typed = editLine(EMPTY_LINE, "say hi", []);
        expect(typed.echo).toBe("say hi");
        expect(typed.submit).toEqual([]);
        const sent = editLine(typed.state, "\r", []);
        expect(sent.submit).toEqual(["say hi"]);
        expect(sent.state.line).toBe("");
    });

    it("takes the last character on Backspace and drops the line on Ctrl+C", () => {
        expect(editLine(EMPTY_LINE, "lisx\x7f", []).state.line).toBe("lis");
        const dropped = editLine(EMPTY_LINE, "stop\x03", []);
        expect(dropped.state.line).toBe("");
        expect(dropped.submit).toEqual([]);
    });

    it("walks the past commands with the arrows", () => {
        const history = ["list", "time set day"];
        const up = editLine(EMPTY_LINE, "\x1b[A", history);
        expect(up.state.line).toBe("time set day");
        const upAgain = editLine(up.state, "\x1b[A", history);
        expect(upAgain.state.line).toBe("list");
        const down = editLine(upAgain.state, "\x1b[B\x1b[B", history);
        expect(down.state.line).toBe("");
    });

    it("sends each line of a paste and ignores blank ones", () => {
        expect(editLine(EMPTY_LINE, "list\r\n\r\nsay hi\r", []).submit).toEqual(["list", "say hi"]);
    });

    it("drops other keys instead of typing them", () => {
        expect(editLine(EMPTY_LINE, "\x1b[Dab\tc\x1bOH", []).state.line).toBe("abc");
    });
});
