/**
 * Which Chat messages are shown in the game: saved on the account, only ever one
 * of the three choices, and direct messages and small groups until somebody
 * chooses otherwise.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: unknown[] = [];
let ready = true;

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/app-extensions/registry", () => ({ chatRelayReady: async () => ready }));
vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            update: async (query: unknown) => {
                updates.push(query);
                return {};
            }
        }
    }
}));

const { setMessagesInGameAction } = await import("@/app/(app)/account/notifications/actions");
const { inGameChoice } = await import("@/lib/chat/in-game-choice");

beforeEach(() => {
    updates.length = 0;
    ready = true;
});

describe("messages in the game", () => {
    it("saves each choice on the account as the relay reads it", async () => {
        expect(await setMessagesInGameAction("all")).toEqual({ choice: "all" });
        expect(await setMessagesInGameAction("off")).toEqual({ choice: "off" });
        expect(await setMessagesInGameAction("auto")).toEqual({ choice: "auto" });
        expect(updates).toEqual([
            { where: { id: "u1" }, data: { inGameMessages: "all" } },
            { where: { id: "u1" }, data: { inGameMessages: "off" } },
            { where: { id: "u1" }, data: { inGameMessages: "auto" } }
        ]);
    });

    it("refuses anything that is not one of the choices, and writes nothing", async () => {
        expect((await setMessagesInGameAction(true)).error).toBeTruthy();
        expect((await setMessagesInGameAction("yes")).error).toBeTruthy();
        expect(updates).toEqual([]);
    });

    it("refuses every choice, and writes nothing, until a server knows which player the account is", async () => {
        ready = false;
        for (const choice of ["auto", "all", "off"]) {
            expect((await setMessagesInGameAction(choice)).error).toMatch(/Minecraft username/);
        }
        expect(updates).toEqual([]);
    });

    it("reads a stored value back as the choice it was", () => {
        expect(inGameChoice("auto")).toBe("auto");
        expect(inGameChoice("all")).toBe("all");
        expect(inGameChoice("off")).toBe("off");
        // Never chosen, or a value this version does not know: everything.
        expect(inGameChoice(null)).toBe("all");
        expect(inGameChoice("later")).toBe("all");
    });

    it("is the default for every account until it is chosen", () => {
        const schema = readFileSync(
            join(__dirname, "../../../../packages/db/prisma/schema.prisma"),
            "utf8"
        );
        expect(schema).toMatch(/inGameMessages String\?\n/);
    });
});
