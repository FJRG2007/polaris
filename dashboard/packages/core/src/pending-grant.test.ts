import { describe, expect, it } from "vitest";
import { parsePendingGrant, pendingGrantSchema } from "./schemas/sharing.js";

const BY = "0190c1d2-0000-7000-8000-000000000001";

describe("what an invite promises", () => {
    it("still needs something to grant when it carries no link", () => {
        expect(
            pendingGrantSchema.safeParse({
                resourceKind: "install",
                resourceId: "server-1",
                actions: [],
                grantedById: BY
            }).success
        ).toBe(false);
    });

    it("may grant nothing when it ties the account to a player", () => {
        // A player invited to a server needs an account, not its console.
        const parsed = parsePendingGrant(
            JSON.stringify({
                resourceKind: "install",
                resourceId: "server-1",
                actions: [],
                grantedById: BY,
                appLink: { kind: "gamePlayer", player: "ErMigue04" }
            })
        );
        expect(parsed?.appLink).toEqual({
            kind: "gamePlayer",
            player: "ErMigue04",
            followSignIns: true
        });
    });

    it("reads a link of a kind nobody knows as no promise at all", () => {
        expect(
            parsePendingGrant(
                JSON.stringify({
                    resourceKind: "install",
                    resourceId: "server-1",
                    actions: [],
                    grantedById: BY,
                    appLink: { kind: "somethingElse", player: "x" }
                })
            )
        ).toBeNull();
    });
});
