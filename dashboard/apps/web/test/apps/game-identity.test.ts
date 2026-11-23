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
let links: { userId: string; provider: string; accountId: string; label: string; method?: string }[] = [];
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

/** Who the viewer may name: the shared rule (`resolveNamedAccount`) is its own
 *  module's test; here only its answer matters. */
let hidden = false;
vi.mock("@/lib/people-search", () => ({
    resolveNamedAccount: async (_viewer: unknown, identifier: string) => {
        const person = people.find(
            (one) => one.username === identifier || one.email === identifier
        );
        return person && !hidden ? { id: person.id, name: person.name, username: person.username } : null;
    }
}));

const VIEWER = { id: "22222222-2222-4222-8222-222222222222", isAdmin: false };

const { findGameIdentity } = await import("@polaris-app/game-servers/src/lib/game-identity");

beforeEach(() => {
    people = [{ id: PAU, name: "Pau", username: "pau", email: "pau@example.com" }];
    links = [];
    asked = null;
    hidden = false;
});

describe("findGameIdentity", () => {
    it("hands back the id of the account they linked", async () => {
        links = [{ userId: PAU, provider: "steam", accountId: "76561198000000001", label: "paulinho" }];

        const found = await findGameIdentity("pau", "steam", VIEWER);
        expect(found?.identity?.accountId).toBe("76561198000000001");
        expect(found?.identity?.label).toBe("paulinho");
        expect(found?.name).toBe("Pau");
    });

    it("finds them by email address as well as by username", async () => {
        links = [{ userId: PAU, provider: "steam", accountId: "76561198000000001", label: "paulinho" }];
        expect((await findGameIdentity("  PAU@Example.com ", "steam", VIEWER))?.identity?.accountId).toBe("76561198000000001");
    });

    it("answers an account the viewer may not find exactly like nobody", async () => {
        // Otherwise typing an address would say whether it has an account here.
        hidden = true;
        expect(await findGameIdentity("pau@example.com", "steam", VIEWER)).toBeNull();
        expect(await findGameIdentity("nobody@example.com", "steam", VIEWER)).toBeNull();
    });

    it("says who they are even when they have linked nothing", async () => {
        // Not the same as "no such person": the screen names them and asks them to
        // link, rather than sending the operator back to check the spelling.
        const found = await findGameIdentity("pau", "steam", VIEWER);
        expect(found?.name).toBe("Pau");
        expect(found?.identity).toBeNull();
    });

    it("does not answer about a link to another service", async () => {
        links = [{ userId: PAU, provider: "github", accountId: "12345", label: "pau" }];
        expect((await findGameIdentity("pau", "steam", VIEWER))?.identity).toBeNull();
    });

    it("keeps one person's services apart", async () => {
        // The same human is three different identities to three different games,
        // and none of them substitutes for another: ARK's door takes the Steam id,
        // a Minecraft server takes the name Mojang holds.
        links = [
            { userId: PAU, provider: "steam", accountId: "76561198000000001", label: "paulinho" },
            { userId: PAU, provider: "minecraft", accountId: "069a79f4-44e9-4726-a5be-fca90e38aaf5", label: "Notch" },
            { userId: PAU, provider: "epic", accountId: "0123456789abcdef0123456789abcdef", label: "pau_epic" }
        ];

        expect((await findGameIdentity("pau", "steam", VIEWER))?.identity?.accountId).toBe("76561198000000001");
        expect((await findGameIdentity("pau", "minecraft", VIEWER))?.identity?.label).toBe("Notch");
        expect((await findGameIdentity("pau", "epic", VIEWER))?.identity?.accountId).toBe(
            "0123456789abcdef0123456789abcdef"
        );
    });

    it("marks a Minecraft name its owner proved as verified", async () => {
        links = [
            {
                userId: PAU,
                provider: "minecraft",
                accountId: "069a79f4-44e9-4726-a5be-fca90e38aaf5",
                label: "Notch",
                method: "oauth"
            }
        ];
        expect((await findGameIdentity("pau", "minecraft", VIEWER))?.identity?.verified).toBe(true);
    });

    it("still answers with a name its owner only typed, marked as not verified", async () => {
        // The name is still the one to add - it is their word for what they are
        // called - but a screen filling it in has to be able to say nobody checked.
        links = [{ userId: PAU, provider: "minecraft", accountId: `manual:${PAU}`, label: "Pau_MC", method: "manual" }];
        const found = await findGameIdentity("pau", "minecraft", VIEWER);
        expect(found?.identity?.label).toBe("Pau_MC");
        expect(found?.identity?.verified).toBe(false);
    });

    it("is nobody for a name that is not here", async () => {
        expect(await findGameIdentity("nobody", "steam", VIEWER)).toBeNull();
    });

    it("asks the database nothing at all for an empty name", async () => {
        expect(await findGameIdentity("   ", "steam", VIEWER)).toBeNull();
        expect(asked).toBeNull();
    });
});
