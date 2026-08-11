/**
 * Turning a Polaris name into the id a game server is closed by.
 *
 * The whole point is that nobody retypes a seventeen-digit number from a chat
 * message, so what matters here is the three answers being distinguishable: an id
 * ready to use, a person who has linked nothing, and a name that is nobody. Fold
 * the last two together and the screen can only say "that did not work" about a
 * friend who is standing right there waiting to be let in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PAU = "11111111-1111-4111-8111-111111111111";

let people: { id: string; name: string; username: string; email: string }[] = [];
let links: { userId: string; provider: string; accountId: string; label: string }[] = [];
let asked: unknown = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findFirst: async ({ where }: { where: { OR: { email?: string; username?: string }[] } }) => {
                asked = where;
                const wanted = where.OR.map((clause) => clause.email ?? clause.username);
                return people.find((person) => wanted.includes(person.email) || wanted.includes(person.username)) ?? null;
            }
        },
        userConnection: {
            findFirst: async ({ where }: { where: { userId: string; provider: string } }) =>
                links.find((link) => link.userId === where.userId && link.provider === where.provider) ?? null
        }
    }
}));

const { findGameIdentity } = await import("@/lib/apps/game-identity");

beforeEach(() => {
    people = [{ id: PAU, name: "Pau", username: "pau", email: "pau@example.com" }];
    links = [];
    asked = null;
});

describe("findGameIdentity", () => {
    it("hands back the id of the account they linked", async () => {
        links = [{ userId: PAU, provider: "steam", accountId: "76561198000000001", label: "paulinho" }];

        const found = await findGameIdentity("pau", "steam");
        expect(found?.identity?.accountId).toBe("76561198000000001");
        expect(found?.identity?.label).toBe("paulinho");
        expect(found?.name).toBe("Pau");
    });

    it("finds them by email address as well as by username", async () => {
        links = [{ userId: PAU, provider: "steam", accountId: "76561198000000001", label: "paulinho" }];
        expect((await findGameIdentity("  PAU@Example.com ", "steam"))?.identity?.accountId).toBe("76561198000000001");
    });

    it("says who they are even when they have linked nothing", async () => {
        // Not the same as "no such person": the screen names them and asks them to
        // link, rather than sending the operator back to check the spelling.
        const found = await findGameIdentity("pau", "steam");
        expect(found?.name).toBe("Pau");
        expect(found?.identity).toBeNull();
    });

    it("does not answer about a link to another service", async () => {
        links = [{ userId: PAU, provider: "github", accountId: "12345", label: "pau" }];
        expect((await findGameIdentity("pau", "steam"))?.identity).toBeNull();
    });

    it("is nobody for a name that is not here", async () => {
        expect(await findGameIdentity("nobody", "steam")).toBeNull();
    });

    it("asks the database nothing at all for an empty name", async () => {
        expect(await findGameIdentity("   ", "steam")).toBeNull();
        expect(asked).toBeNull();
    });
});
