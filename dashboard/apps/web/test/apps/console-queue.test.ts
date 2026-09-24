/**
 * Several console lines, read into a sequence the console runs in order.
 *
 * The sequence an operator runs before a restart - a title, a freeze, a pause, a
 * "done" - is the case this exists for, so it is the case pinned here.
 */

import { describe, expect, it } from "vitest";
import {
    MAX_CONSOLE_LINE,
    MOST_QUEUED,
    commandCount,
    parseQueue
} from "@polaris-app/game-servers/src/lib/console-queue";

describe("a block of console lines", () => {
    it("runs each line in order, with a wait line as a pause between them", () => {
        const { steps, problem } = parseQueue(
            [
                "# before the restart",
                'title @a title {"text":"Reloading..."}',
                "",
                "/effect give @a minecraft:slowness 10 255 true",
                "wait 10",
                "Wait 2.5s",
                'title @a title {"text":"Done!"}'
            ].join("\r\n"),
            MAX_CONSOLE_LINE
        );
        expect(problem).toBeNull();
        expect(steps).toEqual([
            { kind: "command", line: 'title @a title {"text":"Reloading..."}' },
            { kind: "command", line: "effect give @a minecraft:slowness 10 255 true" },
            { kind: "wait", ms: 10_000 },
            { kind: "wait", ms: 2_500 },
            { kind: "command", line: 'title @a title {"text":"Done!"}' }
        ]);
        expect(commandCount(steps)).toBe(3);
    });

    it("keeps a long tellraw whole, however many words its JSON has", () => {
        const tellraw =
            'tellraw @a [{"text":"[Polaris] ","color":"gray"},{"text":"Dymo","color":"light_purple","bold":true},{"text":": ","color":"dark_gray"},{"text":"Restarting... ","color":"gold","bold":true},{"text":"Please don\'t leave the server, a smart automatic restart is about to happen.","color":"yellow"}]';
        expect(parseQueue(tellraw + "\nsay hi", MAX_CONSOLE_LINE).steps[0]).toEqual({
            kind: "command",
            line: tellraw
        });
    });

    it("says what is wrong instead of running half of it", () => {
        expect(parseQueue("# only a note\n\n", MAX_CONSOLE_LINE).problem).toMatch(/no command/);
        expect(parseQueue("say a\nwait 500", MAX_CONSOLE_LINE).problem).toMatch(/Line 2 waits/);
        expect(parseQueue(`say ${"x".repeat(600)}`, MAX_CONSOLE_LINE).problem).toMatch(
            /Line 1 is longer/
        );
        const many = Array.from({ length: MOST_QUEUED + 1 }, (_, index) => `say ${index}`);
        expect(parseQueue(many.join("\n"), MAX_CONSOLE_LINE).problem).toMatch(/more than/);
        expect(parseQueue(many.join("\n"), MAX_CONSOLE_LINE).steps).toEqual([]);
    });

    it("reads a word that only starts like wait as a command", () => {
        expect(parseQueue("waiting room", MAX_CONSOLE_LINE).steps).toEqual([
            { kind: "command", line: "waiting room" }
        ]);
    });
});
