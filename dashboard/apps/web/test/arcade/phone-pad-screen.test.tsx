// @vitest-environment jsdom

/**
 * The phone held as a controller: a game opened on the same account after the
 * page is already up turns up in its list, the stick floats to where the thumb
 * lands and only that finger moves it, and the page holds still under play.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhonePadScreen, WAITING_POLL_MS } from "../../../arcade/src/screens/phone-pad-screen";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useClient: () => "browser", useLocale: () => "en-US" } }
}));
vi.mock("../../../arcade/src/screens/i18n", () => ({
    useArcadeT: () => (key: string) => key
}));

class FakeEventSource {
    static readonly CLOSED = 2;
    readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {}
    close() {
        this.readyState = FakeEventSource.CLOSED;
    }
}

const PAD = { id: "a".repeat(32), token: "b".repeat(32) };
let waiting: { id: string; openedAt: number; game: string; device: string }[] = [];
const frames: { axes: number[]; buttons: number[] }[] = [];

beforeEach(() => {
    waiting = [];
    frames.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url === "/api/arcade/pad") return Response.json({ pads: waiting });
            if (url === "/api/arcade/pad/claim") return Response.json(PAD);
            const body = JSON.parse(String(init?.body ?? "{}"));
            if (body.frame) frames.push(body.frame);
            return new Response(null, { status: 204 });
        })
    );
    // jsdom has no pointer capture
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => true;
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

async function connect() {
    waiting = [{ id: PAD.id, openedAt: Date.now(), game: "new-york", device: "Chrome" }];
    render(<PhonePadScreen />);
    await flush();
    fireEvent.click(await screen.findByRole("button", { name: /pad\.controlOne/ }));
    await flush();
}

describe("the phone controller", () => {
    it("lists a game opened on the account after the page was already up", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        render(<PhonePadScreen />);
        await flush();
        expect(screen.getByText("pad.none")).toBeTruthy();
        waiting = [{ id: PAD.id, openedAt: Date.now(), game: "new-york", device: "Chrome" }];
        await act(async () => {
            vi.advanceTimersByTime(WAITING_POLL_MS);
            await Promise.resolve();
        });
        await flush();
        expect(screen.getByRole("button", { name: /pad\.controlOne/ })).toBeTruthy();
    });

    it("floats the stick to the thumb and lets only that finger move it", async () => {
        await connect();
        const area = document.querySelector('[aria-label="pad.stick"]') as HTMLElement;
        area.getBoundingClientRect = () =>
            ({ left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300 }) as DOMRect;
        fireEvent.pointerDown(area, { pointerId: 1, clientX: 150, clientY: 150 });
        // A second finger landing on the stick does not take it over
        fireEvent.pointerDown(area, { pointerId: 2, clientX: 10, clientY: 10 });
        fireEvent.pointerMove(area, { pointerId: 2, clientX: 10, clientY: 290 });
        fireEvent.pointerMove(area, { pointerId: 1, clientX: 150 + 56, clientY: 150 });
        await flush();
        await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 60))));
        const last = frames.at(-1)!;
        expect(last.axes[0]).toBeCloseTo(1);
        expect(last.axes[1]).toBeCloseTo(0);
        fireEvent.pointerUp(area, { pointerId: 1 });
        await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 60))));
        expect(frames.at(-1)!.axes.slice(0, 2)).toEqual([0, 0]);
    });

    it("holds the page still while it is a controller, and lets go once disconnected", async () => {
        await connect();
        expect(document.body.style.overflow).toBe("hidden");
        expect(document.documentElement.style.overscrollBehavior).toBe("none");
        const pinch = new Event("touchmove", { cancelable: true });
        document.dispatchEvent(pinch);
        expect(pinch.defaultPrevented).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "pad.disconnect" }));
        await flush();
        expect(document.body.style.overflow).toBe("");
        const scroll = new Event("touchmove", { cancelable: true });
        document.dispatchEvent(scroll);
        expect(scroll.defaultPrevented).toBe(false);
    });
});
