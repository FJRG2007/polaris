/**
 * Storing what somebody chose their profile to look like.
 *
 * Two properties, and both are about the absence of a choice rather than a
 * choice. A style with nothing in it takes its row away instead of storing five
 * nulls - the row records a decision, and "I turned it all off" is the absence
 * of one - which also keeps the table the size of the number of people who
 * actually picked something.
 *
 * And a lookup answers for everybody asked about, including the accounts with no
 * row at all. In the store that reads this, "asked and has nothing" and "not
 * asked yet" are different states: leave the plain ones out and it asks about
 * them again on every render for the rest of the session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: { userProfileStyle: { findUnique, findMany, upsert, deleteMany } }
}));

const { getProfileStyle, setProfileStyle, stylesFor } = await import(
    "../../src/lib/profile-style-service"
);

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const PLAIN = { banner: null, decoration: null, nameplate: null, effect: null, nameStyle: null };

beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue(null);
    findMany.mockResolvedValue([]);
});

describe("reading one", () => {
    it("gives an ordinary profile for an account that never opened the panel", async () => {
        expect(await getProfileStyle(ALICE)).toEqual(PLAIN);
    });

    it("drops a choice that is no longer in the catalogue", async () => {
        findUnique.mockResolvedValue({
            banner: "solid:#1b6ac9",
            decoration: "withdrawn-last-year",
            nameplate: null,
            effect: null,
            nameStyle: null
        });
        const style = await getProfileStyle(ALICE);
        expect(style.banner).toEqual({ kind: "solid", color: "#1b6ac9" });
        expect(style.decoration).toBeNull();
    });
});

describe("reading several", () => {
    it("answers for everybody asked about, row or no row", async () => {
        findMany.mockResolvedValue([{ userId: BOB, ...PLAIN, decoration: "aurora" }]);
        const found = await stylesFor([ALICE, BOB]);
        expect(found.get(ALICE)).toEqual(PLAIN);
        expect(found.get(BOB)).toMatchObject({ decoration: "aurora" });
    });

    it("asks about an id once however many times it appears on the screen", async () => {
        await stylesFor([ALICE, ALICE, BOB, ALICE]);
        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: { in: [ALICE, BOB] } } })
        );
    });

    it("does not go to the database for nobody", async () => {
        expect((await stylesFor([])).size).toBe(0);
        expect(findMany).not.toHaveBeenCalled();
    });
});

describe("saving one", () => {
    it("writes the choices down", async () => {
        await setProfileStyle(ALICE, {
            banner: { kind: "gradient", angle: 135, from: "#1b6ac9", to: "#8b3ad6" },
            decoration: "aurora",
            nameplate: null,
            effect: null,
            nameStyle: null
        });
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: ALICE },
                update: expect.objectContaining({
                    banner: "gradient:135:#1b6ac9:#8b3ad6",
                    decoration: "aurora"
                })
            })
        );
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it("takes the row away when everything is turned off", async () => {
        await setProfileStyle(ALICE, PLAIN);
        expect(deleteMany).toHaveBeenCalledWith({ where: { userId: ALICE } });
        expect(upsert).not.toHaveBeenCalled();
    });

    it("takes it away without minding that there was nothing to take", async () => {
        // `deleteMany` rather than `delete`, so turning off a style you never
        // turned on is not an exception on a row that does not exist.
        deleteMany.mockResolvedValue({ count: 0 });
        await expect(setProfileStyle(BOB, PLAIN)).resolves.toBeUndefined();
    });
});
