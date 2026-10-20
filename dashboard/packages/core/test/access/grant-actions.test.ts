/**
 * What a grant may be used for. A key lent to open a door must not lock it, a
 * key lent to lock it at night must not open it, and a row written before
 * grants named their actions must keep doing exactly what it did.
 */

import { describe, expect, it } from "vitest";
import { accessGrantSchema, allowsAction, grantActions } from "../../src/access-grants";

describe("a door", () => {
    it("opens and does not lock when lent only to open", () => {
        expect(allowsAction("place.device", "control", ["open"], "open")).toBe(true);
        expect(allowsAction("place.device", "control", ["open"], "close")).toBe(false);
        expect(allowsAction("place.device", "control", ["open"], "operate")).toBe(false);
    });

    it("locks and does not open when lent only to lock", () => {
        expect(allowsAction("place.device", "control", ["close"], "close")).toBe(true);
        expect(allowsAction("place.device", "control", ["close"], "open")).toBe(false);
    });

    it("does everything control reached before, for a grant that names nothing", () => {
        expect(grantActions("place.device", "control", [])).toEqual(["open", "close", "operate"]);
    });

    it("does nothing at all on a view grant, whatever the row says", () => {
        expect(grantActions("place.device", "view", [])).toEqual([]);
        expect(grantActions("place.device", "view", ["open", "close"])).toEqual([]);
    });

    it("ignores an action the subject does not have", () => {
        expect(grantActions("place.device", "control", ["watch", "open"])).toEqual(["open"]);
    });
});

describe("a camera", () => {
    it("is watched on a view grant", () => {
        expect(grantActions("place.camera", "view", [])).toEqual(["watch"]);
    });
});

describe("a UPS", () => {
    it("is watched and not driven when lent to watch", () => {
        expect(grantActions("place.ups", "view", [])).toEqual(["watch"]);
        expect(allowsAction("place.ups", "view", ["control"], "control")).toBe(false);
    });

    it("is watched and driven when lent control", () => {
        expect(grantActions("place.ups", "control", [])).toEqual(["watch", "control"]);
    });

    it("can be lent control and still be narrowed to watching", () => {
        expect(grantActions("place.ups", "control", ["watch"])).toEqual(["watch"]);
    });
});

describe("the form", () => {
    it("takes no actions as all of them", () => {
        const parsed = accessGrantSchema.parse({
            principalType: "user",
            principalId: "00000000-0000-4000-8000-000000000001",
            capability: "control"
        });
        expect(parsed.actions).toEqual([]);
    });
});
