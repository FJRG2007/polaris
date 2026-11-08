// @vitest-environment jsdom

/**
 * A phone as Skyline Roam's controller: the server's pads (one code, one
 * phone, owner-only one-tap claims), the phone's controls as a standard pad
 * frame, the game's side of the relay, and the start screen choosing it.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import * as pads from "@/lib/arcade/phone-pads";
import * as input from "../../../arcade/src/screens/phone-pad-input";
import * as phonePad from "../../../arcade/game/new-york/engine/phone-pad.js";
import * as start from "../../../arcade/game/shared/start-screen.js";
import { t } from "../../../arcade/game/new-york/engine/i18n.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("phone pads on the server", () => {
    beforeEach(() => pads.resetPadsForTests());

    it("pairs one phone by the code and relays controls in and rumbles out", () => {
        const opened = pads.openPad("owner")!;
        expect(opened.code).toMatch(/^\d{6}$/);
        const host = vi.fn();
        const stop = pads.listenAsHost(opened.id, "owner", host)!;
        const claimed = pads.claimPad({ code: opened.code }, { userId: "guest", name: "Guest" })!;
        expect(host).toHaveBeenLastCalledWith({ kind: "phone", connected: true, name: "Guest" });
        // A second phone cannot take it
        expect(pads.claimPad({ code: opened.code }, { userId: "other", name: "Other" })).toBeNull();
        const frame = { axes: [0.5, 0, 0, 0], buttons: new Array(17).fill(0) };
        expect(pads.sendInput(claimed.id, claimed.token, frame)).toBe(true);
        expect(host).toHaveBeenLastCalledWith({ kind: "input", frame });
        expect(pads.sendInput(claimed.id, "f".repeat(32), frame)).toBe(false);
        const phone = vi.fn();
        pads.listenAsPhone(claimed.id, claimed.token, phone);
        expect(pads.sendRumble(opened.id, "guest", { strong: 1, weak: 1, duration: 100 })).toBe(
            false
        );
        expect(pads.sendRumble(opened.id, "owner", { strong: 1, weak: 1, duration: 100 })).toBe(
            true
        );
        expect(phone).toHaveBeenLastCalledWith({
            kind: "rumble",
            rumble: { strong: 1, weak: 1, duration: 100 }
        });
        // The game's page leaving closes the pad and tells the phone, once it has had time to come back
        vi.useFakeTimers();
        try {
            stop();
            expect(pads.sendInput(claimed.id, claimed.token, frame)).toBe(true);
            vi.advanceTimersByTime(pads.PAD_RECONNECT_MS);
            expect(phone).toHaveBeenLastCalledWith({ kind: "closed" });
            expect(pads.sendInput(claimed.id, claimed.token, frame)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps the pad and its phone while the game's stream reconnects", () => {
        vi.useFakeTimers();
        try {
            const opened = pads.openPad("owner")!;
            const stop = pads.listenAsHost(opened.id, "owner", vi.fn())!;
            const claimed = pads.claimPad(
                { code: opened.code },
                { userId: "guest", name: "Guest" }
            )!;
            const phone = vi.fn();
            pads.listenAsPhone(claimed.id, claimed.token, phone);
            stop();
            vi.advanceTimersByTime(pads.PAD_RECONNECT_MS - 1);
            const host = vi.fn();
            const again = pads.listenAsHost(opened.id, "owner", host)!;
            expect(host).toHaveBeenCalledWith({ kind: "phone", connected: true, name: "Guest" });
            vi.advanceTimersByTime(pads.PAD_RECONNECT_MS * 2);
            expect(phone).not.toHaveBeenCalledWith({ kind: "closed" });
            const frame = { axes: [0, 0, 0, 0], buttons: new Array(17).fill(0) };
            expect(pads.sendInput(claimed.id, claimed.token, frame)).toBe(true);
            expect(host).toHaveBeenLastCalledWith({ kind: "input", frame });
            again();
            stop();
            vi.advanceTimersByTime(pads.PAD_RECONNECT_MS);
            expect(phone).toHaveBeenLastCalledWith({ kind: "closed" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("offers one tap only to the account that opened the pad", () => {
        const opened = pads.openPad("owner")!;
        expect(pads.waitingPads("owner").map((pad) => pad.id)).toEqual([opened.id]);
        expect(pads.waitingPads("guest")).toEqual([]);
        expect(pads.claimPad({ id: opened.id }, { userId: "guest", name: "Guest" })).toBeNull();
        expect(pads.claimPad({ id: opened.id }, { userId: "owner", name: "Owner" })).not.toBeNull();
        expect(pads.waitingPads("owner")).toEqual([]);
    });

    it("keeps an account to a few open pads, dropping the oldest", () => {
        const first = pads.openPad("owner")!;
        for (let i = 0; i < 4; i++) pads.openPad("owner");
        expect(pads.waitingPads("owner")).toHaveLength(4);
        expect(pads.waitingPads("owner").some((pad) => pad.id === first.id)).toBe(false);
        expect(pads.closeOwnedPad(pads.waitingPads("owner")[0]!.id, "guest")).toBe(false);
    });
});

describe("the phone's controls", () => {
    it("clamps the stick to its ring", () => {
        expect(input.stickAxes(50, 0, 100)).toEqual({ x: 0.5, y: 0 });
        const far = input.stickAxes(300, 400, 100);
        expect(Math.hypot(far.x, far.y)).toBeCloseTo(1);
        expect(input.stickAxes(10, 10, 0)).toEqual({ x: 0, y: 0 });
    });

    it("steers by the roll across the way the phone is held", () => {
        expect(input.tiltAxis(0, 15, 0)).toBeCloseTo(0.5);
        expect(input.tiltAxis(15, 0, 90)).toBeCloseTo(0.5);
        expect(input.tiltAxis(15, 0, 270)).toBeCloseTo(-0.5);
        expect(input.tiltAxis(0, 90, 0)).toBe(1);
        expect(input.tiltAxis(null, null, 0)).toBe(0);
    });

    it("sends a standard frame, tilt in place of the stick's x when on", () => {
        const buttons = new Array(17).fill(0);
        buttons[7] = 1;
        const frame = input.padFrame({ stick: { x: -1, y: 0.25 }, tilt: 0.4, buttons });
        expect(frame.axes).toEqual([0.4, 0.25, 0, 0]);
        expect(frame.buttons).toHaveLength(17);
        expect(frame.buttons[7]).toBe(1);
        expect(pads.padFrameSchema.safeParse(frame).success).toBe(true);
    });

    it("links the QR to the phone page on the Polaris domain, the page's origin only without one", () => {
        expect(
            input.phonePadLink("https://polaris.example/", "http://polaris.local", "123456")
        ).toBe("https://polaris.example/games/pad?code=123456");
        expect(input.phonePadLink("", "http://polaris.local", "123456")).toBe(
            "http://polaris.local/games/pad?code=123456"
        );
        expect(input.svgDataUrl("<svg/>")).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
    });
});

/** A window whose parent is a stand-in host, so the game's relay can be driven. */
function framedWindow() {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const parent = { postMessage: vi.fn() };
    const win = {
        parent,
        location: { origin: "https://polaris.example" },
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
            listeners.push(listener)
    };
    const deliver = (data: unknown) =>
        listeners.forEach((listener) =>
            listener({
                data,
                source: parent,
                origin: "https://polaris.example"
            } as unknown as MessageEvent)
        );
    return { win, deliver };
}

describe("the game's phone pad", () => {
    it("is a standard pad while a phone holds it, and forgets its controls when it lets go", () => {
        const { win, deliver } = framedWindow();
        const pad = new phonePad.PhonePad(win as never);
        const changed = vi.fn();
        pad.onChange(changed);
        deliver({
            type: "polaris-game:pad",
            code: "123456",
            link: "https://polaris.example/games/pad?code=123456",
            qr: "data:image/svg+xml,x"
        });
        expect(pad.offer).toEqual({
            code: "123456",
            link: "https://polaris.example/games/pad?code=123456",
            qr: "data:image/svg+xml,x"
        });
        // Controls before a phone holds the pad are not played
        deliver({
            type: "polaris-game:pad-input",
            axes: [1, 0, 0, 0],
            buttons: new Array(17).fill(0)
        });
        expect(pad.pad.axes[0]).toBe(0);
        deliver({ type: "polaris-game:pad", connected: true, name: "Guest" });
        expect(pad.connected).toBe(true);
        expect(pad.pad.mapping).toBe("standard");
        const buttons = new Array(17).fill(0);
        buttons[0] = 1;
        deliver({ type: "polaris-game:pad-input", axes: [2, -0.5, 0, 0], buttons });
        expect(pad.pad.axes).toEqual([1, -0.5, 0, 0]);
        expect(pad.pad.buttons[0]).toMatchObject({ value: 1, pressed: true });
        // A malformed frame changes nothing
        deliver({ type: "polaris-game:pad-input", axes: [0], buttons: [] });
        expect(pad.pad.axes[0]).toBe(1);
        deliver({ type: "polaris-game:pad", connected: false, name: "" });
        expect(pad.connected).toBe(false);
        expect(pad.pad.axes).toEqual([0, 0, 0, 0]);
        expect(changed).toHaveBeenCalledTimes(3);
    });

    it("ignores an offer whose image is not an image", () => {
        expect(
            phonePad.readOffer({ code: "123456", qr: "javascript:alert(1)", link: "javascript:x" })
        ).toEqual({
            code: "123456",
            link: "",
            qr: ""
        });
        expect(phonePad.readOffer({ code: "12345" })).toBeNull();
    });
});

describe("the start screen with a phone", () => {
    const page = readFileSync(
        resolve(__dirname, "../../../arcade/game/new-york/index.html"),
        "utf8"
    );
    const markup = page.match(/<dialog id="start-screen"[\s\S]*?<\/dialog>/)![0];

    beforeAll(() => {
        HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
            this.open = true;
        };
        HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
            this.open = false;
        };
    });
    beforeEach(() => {
        document.body.innerHTML = markup;
        const values = new Map<string, string>();
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value))
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("asks for a code on the phone page and plays with the phone the moment it connects", () => {
        const listeners = new Set<() => void>();
        const phone = {
            offer: null as null | { code: string; link: string; qr: string },
            failed: false,
            connected: false,
            request: vi.fn(),
            onChange: (listener: () => void) => listeners.add(listener)
        };
        const onChoose = vi.fn();
        const view = new start.StartScreen({
            t,
            storageKey: "nyc-input",
            gamepad: () => ({ connected: false, padName: "" }),
            phone: phone as never,
            onChoose,
            onOpenChange: vi.fn()
        });
        view.open();
        // The phone is a way to play on the first page, not behind another
        document.querySelector<HTMLButtonElement>('[data-start-open="phone"]')!.click();
        expect(phone.request).toHaveBeenCalled();
        expect(
            document.querySelector<HTMLButtonElement>('[data-start-choose="phone"]')!.disabled
        ).toBe(true);
        phone.offer = {
            code: "123456",
            link: "https://polaris.example/games/pad?code=123456",
            qr: "data:image/svg+xml,x"
        };
        listeners.forEach((listener) => listener());
        expect(document.getElementById("start-phone-code")!.textContent).toBe("123 456");
        expect(document.querySelector<HTMLImageElement>("#start-phone-qr")!.hidden).toBe(false);
        phone.connected = true;
        listeners.forEach((listener) => listener());
        expect(onChoose).toHaveBeenCalledWith("phone");
        expect(start.rememberedChoice("nyc-input")).toBe("phone");
    });

    it("goes back from the phone page to every way to play", () => {
        const view = new start.StartScreen({
            t,
            storageKey: "nyc-input",
            gamepad: () => ({ connected: false, padName: "" }),
            onChoose: vi.fn(),
            onOpenChange: vi.fn()
        });
        view.open();
        view.show("phone");
        expect(document.getElementById("start-phone-status")!.textContent).not.toBe("");
        view.goBack();
        expect(view.view).toBe("main");
        expect(document.activeElement).toBe(document.querySelector('[data-start-open="phone"]'));
    });
});

describe("a phone on the same account", () => {
    beforeEach(() => pads.resetPadsForTests());

    it("lists the owner's waiting games by game and device, and nobody else's", () => {
        const mine = pads.openPad("owner", { game: "new-york", device: "Chrome on Windows" })!;
        pads.openPad("stranger", { game: "new-york", device: "Firefox on Linux" });
        expect(pads.waitingPads("owner")).toEqual([
            {
                id: mine.id,
                openedAt: expect.any(Number),
                game: "new-york",
                device: "Chrome on Windows"
            }
        ]);
        // An older game page names nothing: still listed, with nothing to name it by
        const bare = pads.openPad("owner")!;
        expect(pads.waitingPads("owner").find((pad) => pad.id === bare.id)).toMatchObject({
            game: "",
            device: ""
        });
    });

    it("connects with one tap only for the owner; another account needs the code", () => {
        const pad = pads.openPad("owner", { game: "new-york" })!;
        expect(pads.claimPad({ id: pad.id }, { userId: "stranger", name: "Stranger" })).toBeNull();
        expect(pads.waitingPads("owner")).toHaveLength(1);
        expect(pads.claimPad({ id: pad.id }, { userId: "owner", name: "Owner" })).not.toBeNull();
        expect(pads.waitingPads("owner")).toEqual([]);
    });
});
