// @vitest-environment jsdom

/**
 * Mail draws the shelf the header is switching to before the server has.
 *
 * Switching shelf waited on the server rendering the whole frame for the new
 * shelf, so the direction whose shelf had more mail to count felt slow. The
 * switcher now announces where it is going; Mail's list follows at once and the
 * server's render takes over when it lands. A refused switch withdraws the
 * announcement and the list goes back.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { announceShelf, shelfAhead, useAnnouncedShelf } from "@/lib/shelf-announce";

const ORG = "018f2b7a-0000-7000-8000-0000000000c3";

/** What Mail's list is drawn for, as the shell works it out. */
function useListShelf(server: string, followsHeader = true): string {
    return shelfAhead(server, useAnnouncedShelf(), followsHeader);
}

afterEach(() => {
    act(() => announceShelf(null));
    cleanup();
});

describe("a shelf switch on its way", () => {
    it("moves the list to the shelf picked before the server answers", () => {
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: ORG }
        });
        expect(view.result.current).toBe(ORG);
        act(() => announceShelf({ from: ORG, to: "personal" }));
        expect(view.result.current).toBe("personal");
    });

    it("hands over to the server's frame once it lands, and stays there", () => {
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: "personal" }
        });
        act(() => announceShelf({ from: "personal", to: ORG }));
        expect(view.result.current).toBe(ORG);
        view.rerender({ server: ORG });
        expect(view.result.current).toBe(ORG);
        act(() => announceShelf(null));
        expect(view.result.current).toBe(ORG);
    });

    it("goes back to where it was when the switch is refused", () => {
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: ORG }
        });
        act(() => announceShelf({ from: ORG, to: "personal" }));
        expect(view.result.current).toBe("personal");
        act(() => announceShelf(null));
        expect(view.result.current).toBe(ORG);
    });

    it("never pulls a list off a shelf the switch did not start from", () => {
        // Left behind by a switch made elsewhere: the server is on a third shelf.
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: "personal" }
        });
        act(() => announceShelf({ from: ORG, to: "personal" }));
        view.rerender({ server: "018f2b7a-0000-7000-8000-0000000000d4" });
        expect(view.result.current).toBe("018f2b7a-0000-7000-8000-0000000000d4");
    });

    it("leaves a list that shows every mailbox where it is", () => {
        const view = renderHook(() => useListShelf("*", false));
        act(() => announceShelf({ from: "*", to: ORG }));
        expect(view.result.current).toBe("*");
    });

    it("is announced by the header's switcher, and withdrawn when refused", () => {
        const switcher = readFileSync(
            resolve(__dirname, "../../src/components/scope-switcher.tsx"),
            "utf8"
        );
        const announced = switcher.indexOf("announceShelf(switching)");
        const asked = switcher.indexOf("setWorkspaceScopeAction(value)");
        expect(announced).toBeGreaterThan(-1);
        expect(announced).toBeLessThan(asked);
        // Once on a refusal and once on a failure.
        expect(switcher.slice(asked).match(/withdraw\(\);/g)?.length).toBe(2);
    });
});
