// @vitest-environment jsdom

/**
 * The page's side of the phone controller: it draws the QR of the phone's link
 * and sends it into the game as an image that draws, and it sends the same
 * offer again when the game asks again for a pad that is already open.
 */

import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhonePadBridge } from "../../../arcade/src/screens/phone-pad-bridge";

vi.mock("@polaris/app-host/client", async () => {
    const { QRCodeSVG } = await import("qrcode.react");
    return {
        hostUi: { qrCode: { QRCodeSVG }, appUrl: { useAppUrl: () => "https://polaris.example" } }
    };
});

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

let posted: ReturnType<typeof vi.fn>;
let frameWindow: Window;

function Host() {
    const frame = useRef<HTMLIFrameElement | null>(null);
    return (
        <>
            <iframe ref={frame} title="game" />
            <PhonePadBridge frame={frame} />
        </>
    );
}

/** The game asking for a pad, from its own window as the bridge expects. */
const askForPad = () =>
    act(async () => {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "polaris-game:pad-open" },
                origin: window.location.origin,
                source: frameWindow
            })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

const offers = () =>
    posted.mock.calls.map(([message]) => message).filter((message) => "code" in message);

beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ id: "a".repeat(32), code: "123456" }))
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the phone pad bridge", () => {
    it("sends the code, the phone's link on the Polaris domain and a QR image that draws", async () => {
        render(<Host />);
        frameWindow = document.querySelector("iframe")!.contentWindow!;
        posted = vi.fn();
        frameWindow.postMessage = posted as unknown as Window["postMessage"];
        await askForPad();
        expect(offers()).toHaveLength(1);
        const [offer] = offers();
        expect(offer).toMatchObject({
            type: "polaris-game:pad",
            code: "123456",
            link: "https://polaris.example/games/pad?code=123456"
        });
        const prefix = "data:image/svg+xml;charset=utf-8,";
        expect(offer.qr.startsWith(prefix)).toBe(true);
        const svg = new DOMParser().parseFromString(
            decodeURIComponent(offer.qr.slice(prefix.length)),
            "image/svg+xml"
        ).documentElement;
        expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
        expect(svg.querySelectorAll("path").length).toBeGreaterThan(1);
    });

    it("sends the same offer again when the game asks again for the pad already open", async () => {
        render(<Host />);
        frameWindow = document.querySelector("iframe")!.contentWindow!;
        posted = vi.fn();
        frameWindow.postMessage = posted as unknown as Window["postMessage"];
        await askForPad();
        await askForPad();
        expect(offers()).toHaveLength(2);
        expect(offers()[1]).toEqual(offers()[0]);
        // Asked again, not opened again: one pad on the server, its code offered once
        const calls = vi.mocked(fetch).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0]![0]).toBe("/api/arcade/pad");
        expect(calls[1]![1]).toMatchObject({ method: "PUT" });
    });

    it("opens a pad with the game, for the owner's phone only, before anyone asks to pair", async () => {
        render(<Host />);
        frameWindow = document.querySelector("iframe")!.contentWindow!;
        posted = vi.fn();
        frameWindow.postMessage = posted as unknown as Window["postMessage"];
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const calls = vi.mocked(fetch).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0]![0]).toBe("/api/arcade/pad");
        expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({ auto: true });
        // No code is offered to the game until it asks to pair
        expect(offers()).toHaveLength(0);
    });
});
