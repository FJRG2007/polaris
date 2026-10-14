/**
 * The people on a Notes shelf, as the person running it reads them.
 *
 * Running a shelf is not a reason to read an address its members keep to
 * themselves: each contact line is the one their privacy setting lets this
 * viewer see, the same rule every other roster in Polaris applies. The raw
 * address must never reach the response for somebody who hid it.
 */

import { describe, expect, it, vi } from "vitest";

const viewers: { id: string; isAdmin: boolean }[] = [];

vi.mock("@/lib/privacy-service", () => ({
    // Only "owner-1" shows their address; everybody else is shown by handle.
    contactLines: async (
        viewer: { id: string; isAdmin: boolean },
        people: { id: string; email: string; username: string | null }[]
    ) => {
        viewers.push(viewer);
        return new Map(
            people.map((person) => [
                person.id,
                viewer.isAdmin || person.id === "owner-1"
                    ? person.email
                    : person.username
                      ? `@${person.username}`
                      : ""
            ])
        );
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        noteSpace: {
            findUnique: async () => ({
                owner: {
                    id: "owner-1",
                    name: "Owner",
                    email: "owner@example.test",
                    username: "owner"
                },
                members: [
                    {
                        role: "editor",
                        user: {
                            id: "member-1",
                            name: "Member One",
                            email: "member-one@example.test",
                            username: "member1"
                        }
                    },
                    {
                        role: "viewer",
                        user: {
                            id: "member-2",
                            name: "Member Two",
                            email: "member-two@example.test",
                            username: null
                        }
                    }
                ]
            })
        }
    }
}));

const { spacePeople } = await import("@/lib/notes/shelf-service");

describe("the people on a shelf", () => {
    it("shows each contact line only as far as its owner allows", async () => {
        const people = await spacePeople("space-1", { id: "owner-1", isAdmin: false });
        expect(people.map((person) => [person.userId, person.email])).toEqual([
            ["owner-1", "owner@example.test"],
            ["member-1", "@member1"],
            ["member-2", ""]
        ]);
        expect(JSON.stringify(people)).not.toContain("member-one@example.test");
        expect(JSON.stringify(people)).not.toContain("member-two@example.test");
    });

    it("asks the privacy rule as the viewer, not as the shelf", async () => {
        await spacePeople("space-1", { id: "viewer-9", isAdmin: false });
        expect(viewers.at(-1)).toEqual({ id: "viewer-9", isAdmin: false });
    });

    it("keeps names, roles and the owner mark as they were", async () => {
        const people = await spacePeople("space-1", { id: "owner-1", isAdmin: true });
        expect(people).toEqual([
            {
                userId: "owner-1",
                name: "Owner",
                email: "owner@example.test",
                role: "admin",
                owner: true
            },
            {
                userId: "member-1",
                name: "Member One",
                email: "member-one@example.test",
                role: "editor",
                owner: false
            },
            {
                userId: "member-2",
                name: "Member Two",
                email: "member-two@example.test",
                role: "viewer",
                owner: false
            }
        ]);
    });
});
