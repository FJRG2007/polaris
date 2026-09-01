/**
 * Answering a username field while somebody types in it.
 *
 * The verdict is the easy half. The half worth testing is what happens when the
 * answer is no: a field that says "taken" and stops is a dead end, and the way
 * out has to be built out of what this account already holds, or it is a list of
 * names belonging to nobody.
 *
 * What is pinned here:
 *
 * - Somebody re-typing the handle they already have is told it is free. Reporting
 *   your own name as taken is the kind of bug that makes a form unusable rather
 *   than wrong.
 * - The suggestions are actually free. Offering a name that is already somebody's
 *   is worse than offering nothing, because it is offered as the fix.
 * - They are built from the person: the two halves of their name and the local
 *   part of their address, not their mail provider and not a bare counter.
 * - Nothing reserved is ever offered, whatever it was built from.
 */

import { describe, expect, it, vi } from "vitest";

/** The handles this instance has already given out. */
let taken: string[] = [];
/** Every `where` the lookup was handed, so the query itself can be asserted. */
const queried: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async ({ where }: { where: { username: { in: string[] }; id: { not: string } } }) => {
                queried.push(where);
                return where.username.in
                    .filter((handle) => taken.includes(handle))
                    .map((handle) => ({ username: handle }));
            }
        }
    }
}));

const { checkUsername, MOST_SUGGESTIONS } = await import("@/lib/username-availability");

const ME = "018f2b7a-0000-7000-8000-00000000000a";
const SEEDS = {
    display: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test"
};

describe("checking one handle", () => {
    it("says a free name is free, and offers nothing", async () => {
        taken = [];
        const verdict = await checkUsername(ME, "ada", SEEDS);
        expect(verdict.free).toBe(true);
        expect(verdict.suggestions).toEqual([]);
    });

    it("normalizes what it was given before answering about it", async () => {
        taken = ["ada"];
        const verdict = await checkUsername(ME, "  ADA  ", SEEDS);
        expect(verdict.handle).toBe("ada");
        expect(verdict.free).toBe(false);
    });

    it("never reports this account's own handle as taken", async () => {
        // The row is excluded by id rather than by comparing the strings, so
        // somebody editing the rest of the form is not told their own name is
        // gone. Asserted on the query, because that is where it is decided.
        taken = ["ada"];
        queried.length = 0;
        await checkUsername(ME, "ada", SEEDS);
        expect(queried[0]).toMatchObject({ id: { not: ME } });
    });
});

describe("what it offers when the name is gone", () => {
    it("offers names that are actually free", async () => {
        taken = ["ada", "ada.1", "ada.lovelace"];
        const verdict = await checkUsername(ME, "ada", SEEDS);
        expect(verdict.free).toBe(false);
        expect(verdict.suggestions.length).toBeGreaterThan(0);
        for (const suggestion of verdict.suggestions) {
            expect(taken).not.toContain(suggestion);
        }
    });

    it("builds them out of who this account is", async () => {
        taken = ["ada"];
        const verdict = await checkUsername(ME, "ada", SEEDS);
        // Their two names, joined - the suggestion a person recognises as theirs
        // rather than as a slot number.
        expect(verdict.suggestions.join(" ")).toContain("adalovelace");
    });

    it("keeps the mail provider out of a suggestion", async () => {
        taken = ["ada"];
        const verdict = await checkUsername(ME, "ada", { ...SEEDS, email: "ada@example.test" });
        for (const suggestion of verdict.suggestions) {
            expect(suggestion).not.toContain("example");
        }
    });

    it("strips the accents off a name rather than refusing it", async () => {
        taken = ["jose"];
        const verdict = await checkUsername(ME, "jose", {
            firstName: "José",
            lastName: "Ramírez",
            email: "jose@example.test"
        });
        expect(verdict.suggestions.join(" ")).toContain("jose.ramirez");
    });

    it("never offers a name Polaris keeps for itself", async () => {
        // "admin" is reserved, so an account called that must not be handed it
        // back as the way out of its own collision.
        taken = ["admin"];
        const verdict = await checkUsername(ME, "admin", {
            display: "admin",
            firstName: "admin",
            lastName: "",
            email: "admin@example.test"
        });
        expect(verdict.suggestions).not.toContain("admin");
    });

    it("stops at a handful", async () => {
        taken = ["ada"];
        const verdict = await checkUsername(ME, "ada", SEEDS);
        expect(verdict.suggestions.length).toBeLessThanOrEqual(MOST_SUGGESTIONS);
    });

    it("asks about the wanted name and every candidate in one query", async () => {
        // A check plus a handful of suggestions is six questions about one
        // column; asking them one at a time is six round trips per keystroke.
        taken = ["ada"];
        queried.length = 0;
        await checkUsername(ME, "ada", SEEDS);
        expect(queried).toHaveLength(1);
    });

    it("answers an empty field without offering it as a name", async () => {
        taken = [];
        const verdict = await checkUsername(ME, "   ", SEEDS);
        expect(verdict.free).toBe(false);
        expect(verdict.suggestions).not.toContain("");
    });
});
