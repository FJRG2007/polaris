import { describe, expect, it } from "vitest";
import { ignoreOpeningPress } from "../src/lib/menu-press";

describe("choosing an option in a menu", () => {
    it("ignores a release whose press did not start inside a menu", () => {
        // The press that opens a menu lands on the trigger, and the menu appears
        // right under the pointer: releasing there must not choose whatever
        // option is now sitting where the pointer came up.
        let stopped = false;
        ignoreOpeningPress({ stopPropagation: () => (stopped = true) } as never);
        expect(stopped).toBe(true);
    });
});
