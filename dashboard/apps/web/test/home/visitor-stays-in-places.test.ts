/**
 * A visitor lent one door stays on the screen they were let onto.
 *
 * The Places screens were opened to somebody holding nothing but a grant, and
 * every action those screens call on load has to be opened with them. The one
 * that is not is not a refusal somebody reads: `requireHome` redirects, a server
 * action that redirects navigates the client that called it, and the visitor is
 * thrown out of Places by the wall drawing itself.
 *
 * It cannot be caught by trying it here - the failure is a redirect from a server
 * action - so the gate each of those actions uses is read off the source. A
 * refusal here names the action and says which gate it should have.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
    resolve(import.meta.dirname, "../../src/app/(app)/places/actions.ts"),
    "utf8"
);

/**
 * Every action a screen a visitor can be on calls without being asked.
 *
 * The wall asks for the cameras and then which of them the relay is serving; the
 * device panel asks for a door's history and its use chart the moment one is
 * selected; the switcher lists the places and sets the one being looked at.
 */
const ON_LOAD = [
    "listCamerasAction",
    "liveCamerasAction",
    "listDevicesAction",
    "listPlacesAction",
    "choosePlaceAction",
    "deviceHistoryAction",
    "deviceUsageAction"
];

/** The first gate one action reaches for, as written. */
function gateOf(action: string): string {
    const at = SOURCE.indexOf(`export async function ${action}(`);
    if (at < 0) throw new Error(`${action} is not in the Places actions`);
    const body = SOURCE.slice(at, at + 1200);
    return /await (requireHome\w*)\(/.exec(body)?.[1] ?? "";
}

describe("the actions a visitor's screen calls on load", () => {
    for (const action of ON_LOAD) {
        it(`lets a visitor into ${action} rather than redirecting them out`, () => {
            // `requireHomeShared` refuses with a sentence the panel shows.
            // `requireHome` redirects, which takes the whole screen with it.
            expect(gateOf(action)).toBe("requireHomeShared");
        });
    }

    it("still keeps the ones that act on the house behind a permission", () => {
        // The other half of the same rule: opening these up would be the bug
        // going the other way.
        expect(gateOf("savePlaceAction")).toBe("requireHome");
        expect(gateOf("deletePlaceAction")).toBe("requireHome");
        expect(gateOf("syncDevicesAction")).toBe("requireHome");
    });
});

describe("what a visitor is told about", () => {
    it("narrows each of those to what they were lent, rather than only letting them in", () => {
        // Opening an action up without narrowing it is the same leak wearing a
        // different hat: every camera in the house, or every property's address.
        for (const action of ON_LOAD) {
            const at = SOURCE.indexOf(`export async function ${action}(`);
            const body = SOURCE.slice(at, at + 1600);
            expect(body).toMatch(/onlyReachable|reachesDevice|reachablePlaces|reach\.devices/);
        }
    });
});
