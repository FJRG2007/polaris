// @vitest-environment jsdom

/**
 * The clock a screen counts its next question from.
 *
 * The store keeps one instant for every face it is drawing: the moment of the
 * last answer, sent back as `since` so the server only has to report what moved.
 * One number for all of them is what makes an idle tab free, and it is also the
 * whole risk - an instant carried further forward than the answers actually
 * reach is a window nobody ever asks about again, and everybody in it keeps the
 * name the page was rendered with for the rest of the session.
 *
 * There is no way to see that from outside except in what the browser asks for
 * next, which is what these assert on: the `since` of the following question.
 *
 * Three ways the clock could run ahead of the answers, all of them silent:
 *
 * - A pass that failed. Nothing came back, so there is nothing to count from.
 * - A pass about part of the screen. A face that has just arrived is asked about
 *   in full, and that answer says nothing about the thirty already drawn.
 * - A revalidation split in two. The people with no answer yet are asked one
 *   thing and everybody else another, and if the two moved the clock separately
 *   the later of them would bury the window under the earlier.
 */

import type { ReactNode } from "react";
import { PersonName } from "@/components/person-name";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ProfileStyleProvider } from "@/components/profile-style-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

/** A server clock that only ever moves forward, so which answer a `since` came
 *  from is readable rather than a matter of how fast the test ran. */
const BASE = Date.UTC(2026, 0, 1);
const STEP = 1_000;

function clockAt(tick: number): string {
    return new Date(BASE + tick * STEP).toISOString();
}

let asked: { ids: string[]; since?: string }[] = [];
/** Whose request the network is refusing, if anybody's. */
let refusing: string | null = null;
let tick = 0;

beforeEach(() => {
    asked = [];
    refusing = null;
    tick = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { ids: string[]; since?: string };
        asked.push(body);
        if (refusing && body.ids.includes(refusing)) return { ok: false, json: async () => ({}) };
        tick += 1;
        const at = clockAt(tick);
        return {
            ok: true,
            json: async () => ({
                people: {},
                names: Object.fromEntries(body.ids.map((id) => [id, `Person ${id.slice(0, 4)}`])),
                ...(body.since ? {} : { nicknames: {} }),
                cleared: [],
                at
            })
        };
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function faces(...ids: string[]): ReactNode {
    return (
        <ProfileStyleProvider>
            {ids.map((id) => (
                <PersonName key={id} id={id} name="Somebody" />
            ))}
        </ProfileStyleProvider>
    );
}

/**
 * A screen holding Ada, which Bob then arrives on. Two moments rather than one,
 * because a face that arrives after the first answer is the whole point: it is
 * the one the clock is not allowed to be moved by.
 */
async function bobArrives(refused: boolean) {
    const view = render(faces(ADA));
    await waitFor(() => expect(asked.length).toBe(1));
    refusing = refused ? BOB : null;
    view.rerender(faces(ADA, BOB));
    await waitFor(() => expect(asked.length).toBe(2));
}

/** Come back to the tab, and give back what it asked for. */
async function revalidation(requests: number) {
    asked = [];
    await act(async () => {
        window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(asked.length).toBe(requests));
    return asked;
}

function sinceOf(requests: { since?: string }[]): string | undefined {
    return requests.find((request) => request.since)?.since;
}

describe("what a revalidation asks for", () => {
    it("asks about each face once", async () => {
        await bobArrives(true);
        // Bob has no answer yet, so he is asked about in full. Ada has one, so she
        // is asked what changed. Nobody is in both: a person asked about twice at
        // once is a wasted request and two answers racing for the same clock.
        const cycle = await revalidation(2);
        expect(cycle.filter((ask) => !ask.since).map((ask) => ask.ids)).toEqual([[BOB]]);
        expect(cycle.filter((ask) => ask.since).map((ask) => ask.ids)).toEqual([[ADA]]);
        const everybody = cycle.flatMap((ask) => ask.ids);
        expect(new Set(everybody).size).toBe(everybody.length);
    });

    it("does not carry the clock past a request that failed", async () => {
        await bobArrives(true);
        // Ada's half of the pass is answered and Bob's is refused, over and over.
        // The clock stands still through all of it: moving it to Ada's answer
        // would put Bob's window behind it forever.
        expect(sinceOf(await revalidation(2))).toBe(clockAt(1));
        expect(sinceOf(await revalidation(2))).toBe(clockAt(1));
    });

    it("does not carry it past a pass that covered part of the screen", async () => {
        await bobArrives(false);
        // Bob's own answer landed, and it is later than Ada's - but it was an
        // answer about Bob. Counting from it would skip everything that happened
        // to Ada in between.
        expect(sinceOf(await revalidation(1))).toBe(clockAt(1));
    });

    it("moves on once every face on screen has been answered for", async () => {
        await bobArrives(true);
        await revalidation(2);
        refusing = null;
        await revalidation(2);
        // Both halves answered, so the pass covers the screen and the clock is
        // free to move - to the earlier of the two answers, never the later.
        const since = sinceOf(await revalidation(1));
        expect(since).toBeDefined();
        expect(String(since) > clockAt(1)).toBe(true);
    });
});
