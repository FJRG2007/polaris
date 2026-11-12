// @vitest-environment jsdom

/**
 * The list of passkeys this browser is known to hold, which decides whether a
 * sign-in or unlock screen may ask for one on its own. The rule under test is
 * that nothing is guessed: only an authenticator the browser calls part of this
 * device goes on it, and what stops answering comes off.
 */

import * as local from "@/lib/local-passkeys";
import { beforeEach, describe, expect, it } from "vitest";
import { freshWebStorage } from "../helpers/memory-storage";

const HELLO = { id: "aGVsbG8td2luZG93cy1oZWxsbw", authenticatorAttachment: "platform" };
const PHONE = { id: "cGhvbmUtb3Zlci1xci1jb2Rl", authenticatorAttachment: "cross-platform" };

beforeEach(() => freshWebStorage());

describe("which passkeys count as on this device", () => {
    it("notes one that answered as part of this device", () => {
        local.rememberLocalPasskey(HELLO);
        expect(local.localPasskeyIds()).toEqual([HELLO.id]);
    });

    it("never notes a phone reached by QR code or a USB key", () => {
        local.rememberLocalPasskey(PHONE);
        expect(local.localPasskeyIds()).toEqual([]);
    });

    it("never notes one whose browser did not say where it lives", () => {
        local.rememberLocalPasskey({ id: HELLO.id });
        local.rememberLocalPasskey({ id: HELLO.id, authenticatorAttachment: null });
        expect(local.localPasskeyIds()).toEqual([]);
    });

    it("keeps one entry per passkey, the latest first", () => {
        const other = { id: "b3RoZXItcGFzc2tleS1oZXJl", authenticatorAttachment: "platform" };
        local.rememberLocalPasskey(HELLO);
        local.rememberLocalPasskey(other);
        local.rememberLocalPasskey(HELLO);
        expect(local.localPasskeyIds()).toEqual([HELLO.id, other.id]);
    });

    it("reads an unreadable list as empty", () => {
        window.localStorage.setItem("polaris.passkeys.local", "{not json");
        expect(local.localPasskeyIds()).toEqual([]);
        window.localStorage.setItem("polaris.passkeys.local", JSON.stringify([{ id: 3 }, "x"]));
        expect(local.localPasskeyIds()).toEqual([]);
    });
});

describe("what comes off the list", () => {
    it("drops a passkey the server no longer knows", () => {
        local.rememberLocalPasskey(HELLO);
        local.forgetLocalPasskeys([HELLO.id]);
        expect(local.localPasskeyIds()).toEqual([]);
    });

    it("drops one after three unanswered prompts in a row, and pauses the tab at the first", () => {
        local.rememberLocalPasskey(HELLO);
        local.missedLocalPasskeys([HELLO.id]);
        expect(local.automaticPasskeyPaused()).toBe(true);
        local.missedLocalPasskeys([HELLO.id]);
        expect(local.localPasskeyIds()).toEqual([HELLO.id]);
        local.missedLocalPasskeys([HELLO.id]);
        expect(local.localPasskeyIds()).toEqual([]);
    });

    it("starts the count again once the passkey answers", () => {
        local.rememberLocalPasskey(HELLO);
        local.missedLocalPasskeys([HELLO.id]);
        local.missedLocalPasskeys([HELLO.id]);
        local.rememberLocalPasskey(HELLO);
        local.missedLocalPasskeys([HELLO.id]);
        expect(local.localPasskeyIds()).toEqual([HELLO.id]);
    });

    it("lifts the pause when asked to", () => {
        local.pauseAutomaticPasskey();
        local.resumeAutomaticPasskey();
        expect(local.automaticPasskeyPaused()).toBe(false);
    });
});

describe("waiting for somebody at the screen", () => {
    it("goes ahead at once when the tab is visible and focused", async () => {
        const focus = document.hasFocus;
        document.hasFocus = () => true;
        try {
            await expect(local.whenAttended(new AbortController().signal)).resolves.toBe(true);
        } finally {
            document.hasFocus = focus;
        }
    });

    it("waits for focus, and gives up when the screen goes away", async () => {
        const focus = document.hasFocus;
        let focused = false;
        document.hasFocus = () => focused;
        try {
            const waiting = local.whenAttended(new AbortController().signal);
            focused = true;
            window.dispatchEvent(new Event("focus"));
            await expect(waiting).resolves.toBe(true);

            focused = false;
            const controller = new AbortController();
            const abandoned = local.whenAttended(controller.signal);
            controller.abort();
            await expect(abandoned).resolves.toBe(false);
        } finally {
            document.hasFocus = focus;
        }
    });
});
