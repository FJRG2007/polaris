// @vitest-environment jsdom

/**
 * Which way a call is carried, decided before anything is opened.
 *
 * There are two implementations of a call and only one of them should ever run,
 * so the interesting assertions are all about the one that does not: an instance
 * with a call server must not also be building browser-to-browser connections,
 * and an instance without one must still get a call rather than an error. Both
 * hooks are called on every render - hooks are - so "not running" means being
 * handed no meeting, which is what is asserted here.
 *
 * The third case is the one that would be found in production otherwise: the
 * answer has not come back yet, and neither implementation may open a microphone
 * on a guess it might have to take back.
 */

import { useCall } from "@/app/(app)/chat/use-call";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What each implementation was handed, in the order it was rendered. */
let throughServer: (string | null)[] = [];
let direct: (string | null)[] = [];
let transport: "sfu" | "mesh" = "mesh";
let refused = false;

vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    callTransportAction: async () => {
        if (refused) throw new Error("offline");
        return transport;
    }
}));

/** Neither hook is exercised here - only which one was given the call. */
function idle(name: string) {
    return () => ({ error: "", meeting: null, participantId: null, from: name }) as never;
}

vi.mock("@/app/(app)/chat/use-sfu-call", () => ({
    useSfuCall: (meetingId: string | null) => {
        throughServer.push(meetingId);
        return idle("sfu")();
    }
}));

vi.mock("@/app/(app)/chat/use-mesh-call", () => ({
    useMeshCall: (meetingId: string | null) => {
        direct.push(meetingId);
        return idle("mesh")();
    }
}));

function Call({ meetingId }: { meetingId: string | null }) {
    const call = useCall(meetingId);
    return <span>{(call as unknown as { from: string }).from}</span>;
}

beforeEach(() => {
    throughServer = [];
    direct = [];
    transport = "mesh";
    refused = false;
});

afterEach(cleanup);

describe("which way a call is carried", () => {
    it("runs the call server implementation, and only that one, when there is a server", async () => {
        transport = "sfu";
        const view = render(<Call meetingId="m1" />);

        await waitFor(() => expect(view.container.textContent).toBe("sfu"));
        expect(throughServer.at(-1)).toBe("m1");
        // The mesh is never handed the call, so it opens nothing and connects to
        // nobody. A second set of peer connections beside the server is the bug
        // this is here to catch.
        expect(direct.every((given) => given === null)).toBe(true);
    });

    it("falls back to browser-to-browser when no call server is set up", async () => {
        transport = "mesh";
        const view = render(<Call meetingId="m1" />);

        await waitFor(() => expect(direct.at(-1)).toBe("m1"));
        expect(view.container.textContent).toBe("mesh");
        expect(throughServer.every((given) => given === null)).toBe(true);
    });

    it("opens nothing at all until the answer is back", () => {
        transport = "sfu";
        render(<Call meetingId="m1" />);

        // The first render happens before the question is answered, and on that
        // render neither implementation may have started: a microphone opened on
        // a guess is a second permission prompt when the guess is wrong.
        expect(throughServer[0]).toBeNull();
        expect(direct[0]).toBeNull();
    });

    it("carries the call directly when the question could not be asked", async () => {
        transport = "sfu";
        refused = true;
        render(<Call meetingId="m1" />);

        // A call that cannot reach the server to ask is still a call between two
        // browsers, which needs nothing to be running anywhere.
        await waitFor(() => expect(direct.at(-1)).toBe("m1"));
        expect(throughServer.every((given) => given === null)).toBe(true);
    });

    it("hands neither of them a call when there is none", async () => {
        render(<Call meetingId={null} />);

        await waitFor(() => expect(direct.length).toBeGreaterThan(0));
        expect(throughServer.every((given) => given === null)).toBe(true);
        expect(direct.every((given) => given === null)).toBe(true);
    });
});
