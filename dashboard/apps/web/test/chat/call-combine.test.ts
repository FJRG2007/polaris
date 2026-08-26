/**
 * Who carries the room when several devices are sitting in one.
 *
 * Every rule here is one that has to be reached the same way by browsers that
 * never speak to each other: the group has no authority in it, and the only
 * thing any of them writes is which seat it is listening through. What is
 * checked is that the answer is the same from every chair - and, in the case
 * that matters most, that a room whose live device closes its laptop does not
 * leave the people still sitting in it silent at both ends.
 */

import { describe, expect, it } from "vitest";
import { audioPlan } from "@/app/(app)/chat/call-combine";

describe("a device on its own", () => {
    it("is in no group and has nothing to say", () => {
        const plan = audioPlan({ id: "b", group: null }, [{ id: "a", group: null }]);
        expect(plan.role).toBeNull();
        expect(plan.host).toBeNull();
        expect(plan.correcting).toBeNull();
    });

    it("is carrying the room as soon as somebody points at it", () => {
        const plan = audioPlan({ id: "b", group: null }, [
            { id: "a", group: "b" },
            { id: "c", group: null }
        ]);
        expect(plan.role).toBe("room");
        expect(plan.host).toBe("b");
        expect(plan.members).toEqual(["a"]);
        // Nothing is written: carrying a room is something other people say
        // about you, which is what makes going quiet need nobody's permission.
        expect(plan.correcting).toBeNull();
    });
});

describe("a device that has gone quiet", () => {
    it("listens through the seat it named", () => {
        const plan = audioPlan({ id: "a", group: "b" }, [
            { id: "b", group: null },
            { id: "c", group: null }
        ]);
        expect(plan.role).toBe("companion");
        expect(plan.host).toBe("b");
        expect(plan.correcting).toBeNull();
    });

    it("counts everybody else in the same room as being with it", () => {
        const plan = audioPlan({ id: "a", group: "b" }, [
            { id: "b", group: null },
            { id: "c", group: "b" },
            { id: "d", group: null }
        ]);
        expect(plan.members).toEqual(["b", "c"]);
    });

    it("follows a chain rather than listening through somebody who is silent", () => {
        // Pointing at a device that is itself quiet would be listening through
        // speakers that are switched off. One hop lands on the live one.
        const plan = audioPlan({ id: "a", group: "b" }, [
            { id: "b", group: "c" },
            { id: "c", group: null }
        ]);
        expect(plan.host).toBe("c");
        expect(plan.correcting).toBe("c");
    });
});

describe("the device carrying the room leaves the call", () => {
    it("hands the room to the lowest seat left, which takes it back", () => {
        // The reported failure exactly: three laptops in a meeting room, the one
        // with the microphone closes, and the two still sitting there can
        // neither hear the call nor be heard by it.
        const plan = audioPlan({ id: "a", group: "z" }, [{ id: "c", group: "z" }]);
        expect(plan.role).toBe("room");
        expect(plan.host).toBe("a");
        // An empty correction is how a browser stops pointing at anybody.
        expect(plan.correcting).toBe("");
        expect(plan.members).toEqual(["c"]);
    });

    it("has everybody else point at whoever took it, without being told", () => {
        const plan = audioPlan({ id: "c", group: "z" }, [{ id: "a", group: "z" }]);
        expect(plan.role).toBe("companion");
        expect(plan.host).toBe("a");
        expect(plan.correcting).toBe("a");
    });

    it("leaves the last one in the room on its own audio", () => {
        const plan = audioPlan({ id: "a", group: "z" }, [{ id: "b", group: null }]);
        expect(plan.role).toBe("room");
        expect(plan.correcting).toBe("");
        expect(plan.members).toEqual([]);
    });
});
