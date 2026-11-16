/**
 * The place picker's pick as a session's start takes it: Polaris, a paired
 * computer through its runner, or one of the person's own servers - and
 * Polaris whenever the pick is gone or offline.
 */

import { describe, expect, it } from "vitest";
import { codePlaceTarget, placeOf } from "@/lib/polar/code-place";

const PLACES = [
    { id: "11111111-1111-4111-8111-111111111111", online: true, kind: "computer" as const },
    { id: "22222222-2222-4222-8222-222222222222", online: true, kind: "server" as const },
    { id: "33333333-3333-4333-8333-333333333333", online: false, kind: "server" as const },
    { id: "44444444-4444-4444-8444-444444444444", online: true }
];

describe("the Code place", () => {
    it("names a computer by its runner and a server by its host", () => {
        expect(placeOf({ kind: "computer", id: PLACES[0]!.id })).toEqual({
            place: "computer",
            hostId: null,
            runnerId: PLACES[0]!.id
        });
        expect(placeOf({ kind: "server", id: PLACES[1]!.id })).toEqual({
            place: "host",
            hostId: PLACES[1]!.id,
            runnerId: null
        });
        expect(placeOf({ kind: "polaris", id: null })).toEqual({ place: "local", hostId: null, runnerId: null });
        expect(placeOf({ kind: "server", id: null })).toEqual({ place: "local", hostId: null, runnerId: null });
    });

    it("reads the pick against what is listed and online", () => {
        expect(codePlaceTarget(PLACES, PLACES[1]!.id)).toEqual({ kind: "server", id: PLACES[1]!.id });
        expect(codePlaceTarget(PLACES, PLACES[2]!.id)).toEqual({ kind: "polaris", id: null });
        expect(codePlaceTarget(PLACES, "gone")).toEqual({ kind: "polaris", id: null });
        expect(codePlaceTarget(null, PLACES[0]!.id)).toEqual({ kind: "polaris", id: null });
        expect(codePlaceTarget(PLACES, null)).toEqual({ kind: "polaris", id: null });
    });

    it("takes an entry from before servers were listed as a computer", () => {
        expect(codePlaceTarget(PLACES, PLACES[3]!.id)).toEqual({ kind: "computer", id: PLACES[3]!.id });
    });
});
