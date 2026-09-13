// @vitest-environment jsdom

/**
 * Which of somebody's two names a screen actually draws.
 *
 * A person has one name they chose and, sometimes, one the reader gave them. The
 * store asks about both at once, because both are drawn beside the same face and
 * a second pipe would be twice the requests for half the answer - but they are
 * not interchangeable, and the store's answer is what every screen ends up
 * showing: it overwrites the name a page was rendered with, on every surface, as
 * soon as it lands.
 *
 * So the two rules asserted here:
 *
 * - Where Polaris is showing a reader their own people, the name is the one the
 *   reader gave. That is the point of a nickname, and it has to survive both a
 *   reload and its subject renaming themselves.
 * - Where a name is a claim about who somebody is - a moderation queue, an
 *   administration table, a field that names an account - it is the name the
 *   account has. An administrator lifting a ban has to be reading the name the
 *   ban was placed on, not a label somebody invented in private.
 *
 * And the reason the browser asks in more than one request: what it asks about
 * is every face drawn since the page loaded, not the ones on screen, and the
 * endpoint refuses a list longer than it will look up. A refusal has nowhere to
 * appear, so before it was cut, an afternoon of scrolling ended with every name
 * and every decoration frozen for the rest of the session.
 */

import type { ReactNode } from "react";
import { MAX_PEOPLE_PER_STYLE_ASK } from "@polaris/core";
import { ProfileStyleProvider } from "@/components/profile-style-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonName, PlainNames, RealNames } from "@/components/person-name";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const ADA = "11111111-1111-4111-8111-111111111111";

/** What the server would say about Ada right now. */
let names: Record<string, string> = {};
let nicknames: Record<string, string> = {};
/** Every request that went out, so the shape of the asking can be asserted. */
let asked: { ids: string[]; since?: string }[] = [];

beforeEach(() => {
    asked = [];
    names = { [ADA]: "Ada" };
    nicknames = { [ADA]: "Dad" };
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { ids: string[]; since?: string };
        asked.push(body);
        const mine = (given: Record<string, string>): Record<string, string> =>
            Object.fromEntries(body.ids.filter((id) => given[id]).map((id) => [id, given[id]]));
        return {
            ok: true,
            json: async () => ({
                people: {},
                names: mine(names),
                // A revalidation carries no nicknames, exactly as the route does.
                ...(body.since ? {} : { nicknames: mine(nicknames) }),
                cleared: [],
                at: new Date().toISOString()
            })
        };
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function drawn(children: ReactNode) {
    return render(<ProfileStyleProvider>{children}</ProfileStyleProvider>);
}

describe("the name a screen shows", () => {
    // The name the page was rendered with is deliberately neither of the two the
    // server will answer, so a passing assertion is the answer having landed
    // rather than the fallback still being on screen.
    it("is the one this reader gave them", async () => {
        drawn(<PersonName id={ADA} name="Ada Lovelace" />);
        expect(await screen.findByText("Dad")).toBeTruthy();
    });

    it("is the account's own where a name says who somebody is", async () => {
        drawn(
            <RealNames>
                <PersonName id={ADA} name="Ada Lovelace" />
            </RealNames>
        );
        expect(await screen.findByText("Ada")).toBeTruthy();
        expect(screen.queryByText("Dad")).toBeNull();
    });

    it("is the account's own in a list of accounts as records", async () => {
        // `PlainNames` already covers administration and the pickers. It carries
        // this too, so a table added there next is not a decision again.
        drawn(
            <PlainNames>
                <PersonName id={ADA} name="Ada Lovelace" />
            </PlainNames>
        );
        expect(await screen.findByText("Ada")).toBeTruthy();
        expect(screen.queryByText("Dad")).toBeNull();
    });

    it("survives its subject renaming themselves", async () => {
        drawn(<PersonName id={ADA} name="Ada Lovelace" />);
        await screen.findByText("Dad");
        // The revalidation: she renames herself, and the answer carries the new
        // name with no nickname beside it. A reader who calls her something else
        // goes on seeing their own name for her.
        names = { [ADA]: "Ada Byron" };
        await act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
        await waitFor(() => expect(asked.some((ask) => ask.since)).toBe(true));
        expect(screen.getByText("Dad")).toBeTruthy();
    });

    it("goes back to their own once the nickname comes off", async () => {
        drawn(<PersonName id={ADA} name="Ada Lovelace" />);
        await screen.findByText("Dad");
        // What the dialog does after a save, which is also what it does after a
        // save that cleared the box. An answer with no nickname for somebody it
        // was asked about is a nickname taken off, not one left unsaid.
        nicknames = {};
        await act(async () => {
            window.dispatchEvent(new CustomEvent("polaris:appearance", { detail: [ADA] }));
        });
        expect(await screen.findByText("Ada")).toBeTruthy();
    });
});

describe("asking about more people than one request may carry", () => {
    it("cuts the list at what the server will answer", async () => {
        const crowd = Array.from(
            { length: MAX_PEOPLE_PER_STYLE_ASK + 50 },
            (_, index) => `${`${index}`.padStart(8, "0")}-1111-4111-8111-111111111111`
        );
        names = Object.fromEntries(crowd.map((id) => [id, `Person ${id}`]));
        nicknames = {};
        drawn(
            <>
                {crowd.map((id) => (
                    <PersonName key={id} id={id} name="Somebody" />
                ))}
            </>
        );

        await waitFor(() => expect(asked.length).toBe(2));
        for (const ask of asked)
            expect(ask.ids.length).toBeLessThanOrEqual(MAX_PEOPLE_PER_STYLE_ASK);
        // Nobody is dropped on the way: the cut is where the requests divide, not
        // where the page stops being asked about.
        expect(asked.flatMap((ask) => ask.ids).sort()).toEqual([...crowd].sort());
        expect(await screen.findByText(`Person ${crowd[crowd.length - 1]}`)).toBeTruthy();
    });
});
