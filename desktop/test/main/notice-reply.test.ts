/**
 * A notice with a field to answer in.
 *
 * Asked for by the page for a message, drawn with the system's own reply field,
 * and the answer handed back and the notice taken down - the way a messenger's
 * notice behaves. A notice that was not asked to take an answer has no field.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as { options: Record<string, unknown>; handlers: Map<string, (...args: unknown[]) => void>; closed: boolean; }[]);

vi.mock("electron", () => ({
    Notification: class {
        static isSupported() {
            return true;
        }

        private readonly entry;

        constructor(options: Record<string, unknown>) {
            this.entry = { options, handlers: new Map<string, (...args: unknown[]) => void>(), closed: false };
            made.push(this.entry);
        }

        on(name: string, handler: (...args: unknown[]) => void) {
            this.entry.handlers.set(name, handler);
            return this;
        }

        show() {}

        close() {
            this.entry.closed = true;
        }
    }
}));

const { showNotice } = await import("@/main/notices");

beforeEach(() => {
    made.length = 0;
});

describe("a notice that can be answered", () => {
    it("draws the system's reply field, hands the answer back, and goes", () => {
        const answers: string[] = [];
        showNotice({
            title: "Ana",
            body: "are you coming?",
            tag: "message:c1",
            reply: { placeholder: "Reply to Ana", onReply: (text) => answers.push(text) }
        });
        expect(made[0]?.options).toMatchObject({ hasReply: true, replyPlaceholder: "Reply to Ana" });
        made[0]?.handlers.get("reply")?.({}, "on my way");
        expect(answers).toEqual(["on my way"]);
        expect(made[0]?.closed).toBe(true);
    });

    it("has no field when it was not asked to take an answer", () => {
        showNotice({ title: "Deployed", tag: "deploy:d1" });
        expect(made[0]?.options.hasReply).toBeUndefined();
        expect(made[0]?.handlers.has("reply")).toBe(false);
    });

    it("draws its buttons, and hands a press back by the button's id", () => {
        const pressed: string[] = [];
        showNotice({
            title: "Ana",
            tag: "message:c1",
            actions: [{ id: "read", text: "Mark as read" }],
            onAction: (action) => pressed.push(action)
        });
        expect(made[0]?.options).toMatchObject({ actions: [{ type: "button", text: "Mark as read" }] });
        made[0]?.handlers.get("action")?.({ actionIndex: 0 }, 0);
        expect(pressed).toEqual(["read"]);
        expect(made[0]?.closed).toBe(true);
    });
});
