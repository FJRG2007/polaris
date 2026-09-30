/**
 * The colours of what events and challenges say in the chat: one palette, the
 * values a player looks for picked out, and every line still one command the
 * console tool will send.
 */

import { describe, expect, it } from "vitest";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as challengeMessages from "@polaris-app/game-servers/src/lib/minecraft/challenges/messages";
import { COMMAND_BYTES_MAX, commandBytes } from "@polaris-app/game-servers/src/lib/minecraft/command-size";

type Part = { text?: string; color?: string; bold?: boolean; underlined?: boolean };

/** The parts of a `tellraw` line, as the game reads them. */
function partsOf(command: string): Part[] {
    const json = JSON.parse(command.slice(command.indexOf(" ", "tellraw ".length) + 1)) as unknown;
    const flat: Part[] = [];
    const walk = (node: unknown) => {
        if (typeof node === "string") flat.push({ text: node });
        else if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === "object") flat.push(node as Part);
    };
    walk(json);
    return flat.filter((part) => (part.text ?? "") !== "");
}

const LONG_NAME = "Friday night mega build battle";
const PLAYER = "Maximilian_1234";

/** Every chat line an event says, with long values, in one language. */
function chatLines(language: "en" | "es"): string[] {
    const tag = messages.tag(language);
    return [
        messages.startsInWithRules(LONG_NAME, 3599, messages.rules("build-battle", language), language),
        messages.startLine(LONG_NAME, messages.rules("team-duel", language), 60, language),
        messages.cancelledLine(LONG_NAME, language, "No dry ground was found for it near the players"),
        messages.cancelledLine(LONG_NAME, language, "Only 1 joined; it needs 2"),
        messages.podiumLine(1, PLAYER, "1234 points", language),
        messages.disqualifiedLine([PLAYER, PLAYER, PLAYER, PLAYER], language),
        messages.rewardGiven(LONG_NAME, language),
        messages.droppedAtFeet(64, "experience bottle", language),
        messages.dropExact(-29999984, 319, 29999984, language),
        messages.bossAppeared("El Señor de la Guerra", -29999984, 319, 29999984, language),
        messages.bossFell("El Señor de la Guerra", PLAYER, language),
        messages.questionLine(15, 15, "x".repeat(200), language),
        messages.roundWon(PLAYER, "an answer somebody wrote for their own question", language),
        messages.circleAt(-29999984, 319, 29999984, language),
        messages.wavesPointAt(-29999984, 319, 29999984, language),
        messages.meteorAt(-29999984, 319, 29999984, 99, language),
        messages.huntClueFar(10, 1000, "north-west", { x: -29999984, z: 29999984 }, language),
        messages.huntOpened(PLAYER, 9, language),
        messages.joinHint(language),
        messages.notEnoughJoined(1, 50, language),
        messages.finishedLine(PLAYER, "59:59.95", 12, language),
        messages.spleefOut(PLAYER, 11, language),
        messages.duelDown(PLAYER, PLAYER, language),
        messages.voteHow(language),
        messages.allDone(language)
    ].map((line) => commands.say(tag + line));
}

describe("the chat's palette", () => {
    it("says a call-off in red with the reason in white, and the event's name picked out", () => {
        const parts = partsOf(
            commands.say(messages.tag("en") + messages.cancelledLine("Spleef", "en", "Only 1 joined; it needs 2"))
        );
        expect(parts[0]).toMatchObject({ text: "[Event]", color: "gold", bold: true });
        expect(parts.find((part) => part.text === "Spleef")).toMatchObject({ color: "aqua", bold: true });
        expect(parts.find((part) => part.text === " was called off: ")).toMatchObject({ color: "red" });
        expect(parts.find((part) => part.text?.startsWith("Only 1 joined"))?.color).toBeUndefined();
        expect(parts.find((part) => part.text === " was called off: ")?.bold).toBeUndefined();
    });

    it("says a prize in green, a warning in yellow, and what is only news in gray", () => {
        const prize = partsOf(commands.say(messages.rewardGiven("Mining rush", "es")));
        expect(prize[0]).toMatchObject({ text: "Has recibido tu premio de ", color: "green" });
        expect(prize[1]).toMatchObject({ text: "Mining rush", color: "aqua", bold: true });
        const full = partsOf(commands.say(messages.droppedAtFeet(3, "diamond", "en")));
        expect(full[0]).toMatchObject({ text: "Inventory full: ", color: "yellow" });
        expect(full[1]).toMatchObject({ text: "3 diamond", color: "aqua", bold: true });
        expect(partsOf(commands.say(messages.rewardWaiting("en")))[0]?.color).toBe("gray");
    });

    it("draws every button bold and underlined", () => {
        const offer = messages.doneOffer("es");
        const button = partsOf(
            commands.buttonsLine("Ana", offer.lead, [{ ...offer.done, color: "green", value: commands.DONE_VALUE }])
        ).find((part) => part.text === "[Terminado]");
        expect(button).toMatchObject({ text: "[Terminado]", color: "green", bold: true, underlined: true });
    });

    it("keeps the countdown to one line with its rules", () => {
        const line = messages.startsInWithRules("Parkour race", 30, messages.rules("parkour", "en"), "en");
        expect(line).not.toContain("\n");
        expect(line.replace(/&[0-9a-fk-or]/g, "")).toBe(
            "Parkour race starts in 0:30. Fastest to the finish wins; a fall only sends you back to your checkpoint."
        );
    });

    it("keeps every line one command the console tool sends, in both languages", () => {
        for (const language of ["en", "es"] as const) {
            for (const line of chatLines(language)) {
                expect(line).not.toContain("\n");
                expect(commandBytes(line), line.slice(0, 120)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            }
            const buttons = messages.joinButtonsText(language);
            const join = commands.joinButtons(messages.tag(language) + buttons.lead, buttons.join, buttons.leave);
            expect(commandBytes(join)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        }
    });

    it("is the challenges' palette too", () => {
        expect(challengeMessages.tag("en")).toBe(messages.TAG.replace("[Event]", "[Challenges]"));
        const done = challengeMessages.completedLine("Mine 32 diamond ore", "+20 pts, 3 diamond", "es");
        expect(done).toContain(`${messages.PALETTE.good}¡Completado! ${messages.PALETTE.mark}Mine 32 diamond ore`);
    });
});
