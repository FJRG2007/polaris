/**
 * The game answers every RCON connection out of one shared buffer, so two commands
 * in flight at once can each read the other's answer. Every command Polaris sends
 * to one server therefore waits for the one before it - and a failed command must
 * not stop the ones behind it.
 */

import { describe, expect, it } from "vitest";
import { inRconTurn } from "@polaris-app/game-servers/src/lib/minecraft/rcon-turn";

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one RCON exchange at a time", () => {
    it("runs a server's commands one after the other, in the order they were sent", async () => {
        const seen: string[] = [];
        let open = 0;
        let most = 0;
        const command = (name: string, ms: number) =>
            inRconTurn("server-a", async () => {
                open += 1;
                most = Math.max(most, open);
                seen.push(`${name} start`);
                await later(ms);
                seen.push(`${name} end`);
                open -= 1;
                return name;
            });
        const answers = await Promise.all([command("one", 20), command("two", 1), command("three", 5)]);
        expect(answers).toEqual(["one", "two", "three"]);
        expect(most).toBe(1);
        expect(seen).toEqual(["one start", "one end", "two start", "two end", "three start", "three end"]);
    });

    it("keeps going after a command that failed, and hands that failure to its own caller", async () => {
        const failed = inRconTurn("server-b", async () => {
            throw new Error("The server did not answer in time");
        });
        const next = inRconTurn("server-b", async () => "answered");
        await expect(failed).rejects.toThrow("did not answer");
        await expect(next).resolves.toBe("answered");
    });

    it("does not make two different servers wait for each other", async () => {
        let other = false;
        const slow = inRconTurn("server-c", async () => {
            await later(30);
            return other;
        });
        await inRconTurn("server-d", async () => {
            other = true;
        });
        expect(await slow).toBe(true);
    });
});
