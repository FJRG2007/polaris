// @vitest-environment jsdom

/**
 * A notice drawn by the desktop app that can be answered where it is.
 *
 * The app draws the field and hands back what was written; the page knows where
 * the answer goes. What is pinned: the field is asked for only where the app can
 * hand an answer back, and the function to send it never crosses into the app;
 * an answer reaches the notice it was written on, once; an app older than the
 * feature still draws the notice, without the field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (reply: { tag: string; text: string }) => void;

function installApp(withReplies: boolean) {
    const drawn: Record<string, unknown>[] = [];
    let heard: Listener | null = null;
    (window as { polarisDesktop?: unknown }).polarisDesktop = {
        version: "1.0.0",
        platform: "win32",
        notify: async (input: Record<string, unknown>) => {
            drawn.push(input);
            return true;
        },
        closeNotice: async () => undefined,
        pickFolder: async () => null,
        pushLocal: async () => ({ ok: true }),
        openWindow: async () => ({ ok: true }),
        ...(withReplies
            ? {
                  onNoticeReply: (listener: Listener) => {
                      heard = listener;
                      return () => undefined;
                  }
              }
            : {})
    };
    return { drawn, answer: (reply: { tag: string; text: string }) => heard?.(reply) };
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("answering a notice in the desktop app", () => {
    it("asks for the field, and hands the answer to the notice it was written on, once", async () => {
        const app = installApp(true);
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        const send = vi.fn(async () => undefined);
        await notifyDesktop({
            title: "Ana",
            body: "are you coming?",
            tag: "message:c1",
            reply: { placeholder: "Reply to Ana", send }
        });
        expect(app.drawn[0]).toEqual({
            title: "Ana",
            body: "are you coming?",
            tag: "message:c1",
            reply: { placeholder: "Reply to Ana" }
        });
        app.answer({ tag: "message:c2", text: "wrong notice" });
        app.answer({ tag: "message:c1", text: "  on my way " });
        app.answer({ tag: "message:c1", text: "again" });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith("on my way");
    });

    it("draws the notice without the field in an app too old to hand an answer back", async () => {
        const app = installApp(false);
        const { notifyDesktop } = await import("@/lib/desktop-notify");
        await notifyDesktop({
            title: "Ana",
            tag: "message:c1",
            reply: { placeholder: "Reply to Ana", send: async () => undefined }
        });
        expect(app.drawn[0]).toEqual({ title: "Ana", tag: "message:c1" });
    });
});
