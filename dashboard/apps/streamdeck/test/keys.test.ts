/**
 * What a key draws: its face for every state the deck can be in, and the SVG
 * that face becomes.
 */

import { wordsFor } from "../src/words";
import { describe, expect, it } from "vitest";
import type { DeckAction } from "../src/polaris";
import { faceFor, runOptions, turnLevel, watchOptions } from "../src/face";
import { clip, escapeXml, keyImage, renderKey } from "../src/render";

const words = wordsFor("en");
const unread: DeckAction = {
    id: "chat.unread",
    kind: "state",
    area: "chat",
    label: "Unread messages",
    icon: "message-circle",
    options: [],
    live: true
};

describe("faceFor", () => {
    it("asks to connect a deck that never was", () => {
        expect(faceFor("unset", { action: "chat.unread" }, unread, undefined, words)).toEqual({
            icon: "plug",
            tone: "off",
            label: "Connect"
        });
    });

    it("asks to sign in again once the key stops working", () => {
        expect(
            faceFor("unauthorized", { action: "chat.unread" }, unread, undefined, words)
        ).toMatchObject({
            icon: "lock",
            tone: "bad",
            label: "Sign in"
        });
    });

    it("asks for an action on a key with none, and on one set to something gone", () => {
        expect(faceFor("online", {}, undefined, undefined, words).label).toBe("Pick one");
        expect(faceFor("online", { action: "gone" }, undefined, undefined, words)).toMatchObject({
            icon: "circle-alert",
            label: "Pick one"
        });
    });

    it("says offline rather than drawing a stale value", () => {
        expect(
            faceFor(
                "offline",
                { action: "chat.unread" },
                unread,
                { tone: "warn", value: "3" },
                words
            )
        ).toEqual({ icon: "message-circle", tone: "off", label: "Offline" });
    });

    it("draws Polaris's state, with the person's own name when they gave one", () => {
        expect(
            faceFor(
                "online",
                { action: "chat.unread", label: " Inbox " },
                unread,
                { tone: "warn", value: "3" },
                words
            )
        ).toEqual({ icon: "message-circle", tone: "warn", value: "3", label: "Inbox" });
    });

    it("prefers a status line Polaris sent over the action's name", () => {
        expect(
            faceFor(
                "online",
                { action: "chat.unread" },
                unread,
                { tone: "ok", detail: "running" },
                words
            ).label
        ).toBe("running");
    });

    it("reads Spanish for a Spanish Stream Deck and English for anything else", () => {
        expect(wordsFor("es").offline).toBe("Sin red");
        expect(wordsFor("de").offline).toBe("Offline");
    });
});

describe("runOptions and turnLevel", () => {
    it("copies a key's options and ignores anything that is not an object", () => {
        expect(runOptions({ options: { a: 1 } })).toEqual({ a: 1 });
        expect(runOptions({})).toEqual({});
    });

    it("turns five points a tick and holds between 1 and 100", () => {
        expect(turnLevel(50, 2)).toBe(60);
        expect(turnLevel(98, 3)).toBe(100);
        expect(turnLevel(3, -5)).toBe(1);
        expect(turnLevel("nonsense", 0)).toBe(50);
    });

    it("watches a dial without the level it is turned to, so turning it keeps the stream", () => {
        const settings = { options: { deviceId: "d1", level: 70 } };
        expect(watchOptions(settings, "dial")).toEqual({ deviceId: "d1" });
        expect(watchOptions(settings, "key")).toEqual({ deviceId: "d1", level: 70 });
        expect(runOptions(settings)).toEqual({ deviceId: "d1", level: 70 });
    });
});

describe("renderKey", () => {
    it("draws a 144 pixel key with the tone's colour and the value", () => {
        const svg = renderKey({ icon: "bell", tone: "bad", value: "12", label: "Alarms" });
        expect(svg).toMatch(/^<svg [^>]*width="144" height="144"/);
        expect(svg).toContain('fill="#7f1d1d"');
        expect(svg).toContain(">12</text>");
        expect(svg).toContain(">Alarms</text>");
    });

    it("draws the bar across the top only for a toggle that is on", () => {
        expect(renderKey({ icon: "moon", tone: "warn", on: true })).toContain('y="6" width="112"');
        expect(renderKey({ icon: "moon", tone: "idle", on: false })).not.toContain(
            'y="6" width="112"'
        );
    });

    it("escapes text from Polaris and cuts what does not fit", () => {
        const svg = renderKey({ icon: "send", tone: "idle", label: '<script>"x"' });
        expect(svg).not.toContain("<script>");
        expect(escapeXml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
        expect(clip("Light brightness", 13)).toBe("Light bright…");
        expect(clip("Short", 13)).toBe("Short");
    });

    it("falls back to a question mark for an icon it does not know", () => {
        expect(renderKey({ icon: "no-such-icon", tone: "idle" })).toContain("<circle");
    });

    it("is handed to the key as an SVG data URL", () => {
        expect(keyImage({ icon: "bell", tone: "ok" })).toMatch(
            /^data:image\/svg\+xml;charset=utf8,%3Csvg/
        );
    });
});
