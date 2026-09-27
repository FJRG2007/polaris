/**
 * The switch for Chat messages in the game: saved on the account, only ever a
 * yes or a no, and off until somebody turns it on.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: unknown[] = [];

vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "u1" }) }));
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

beforeEach(() => {
    updates.length = 0;
});

describe("messages in the game", () => {
    it("saves a yes or a no on the account", async () => {
        expect(await setMessagesInGameAction(true)).toEqual({ on: true });
        expect(updates).toEqual([{ where: { id: "u1" }, data: { messagesInGame: true } }]);
    });

    it("refuses anything that is not a yes or a no, and writes nothing", async () => {
        expect((await setMessagesInGameAction("yes")).error).toBeTruthy();
        expect(updates).toEqual([]);
    });

    it("is off for every account until it is turned on", () => {
        const schema = readFileSync(join(__dirname, "../../../../packages/db/prisma/schema.prisma"), "utf8");
        expect(schema).toMatch(/messagesInGame Boolean @default\(false\)/);
    });
});
