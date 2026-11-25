// @vitest-environment jsdom
/**
 * The thread keeps to its newest line until the person scrolls up themselves.
 * A scroll the browser fires on its own - the one the thread's own pin raises,
 * arriving a frame late after more lines landed, a clamp, an anchoring shift -
 * is not the person leaving the end, and the composer growing under the thread
 * does not hide its last line.
 *
 * jsdom has no layout, so each box's heights are set by hand and the
 * ResizeObserver is a stub the test fires, in the order a browser would.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { PolarThreadFrame } from "@/components/polar/polar-layout";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

class StubResizeObserver {
    private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
    constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
    }
    observe(target: Element) {
        this.entry.targets.push(target);
    }
    unobserve() {}
    disconnect() {
        this.entry.targets = [];
    }
}

/** A browser's resize delivery for `target`: every observer watching it. */
function resized(target: Element) {
    act(() => {
        for (const { callback, targets } of observers)
            if (targets.includes(target)) callback([], {} as ResizeObserver);
    });
}

/** A scroller whose heights the test sets, with the clamping a browser does. */
function geometry(node: HTMLElement, content: HTMLElement) {
    const box = { height: 400, client: 300, top: 0 };
    const max = () => Math.max(0, box.height - box.client);
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => box.height });
    Object.defineProperty(node, "clientHeight", { configurable: true, get: () => box.client });
    Object.defineProperty(node, "scrollTop", {
        configurable: true,
        get: () => box.top,
        set: (value: number) => {
            box.top = Math.min(Math.max(0, value), max());
        }
    });
    return {
        box,
        atEnd: () => box.top === max(),
        /** New lines below: the content grows, and the observer says so. */
        grow(by: number) {
            box.height += by;
            resized(content);
        },
        /** The browser delivering a scroll event for where the box is now. */
        scrollEvent() {
            fireEvent.scroll(node);
        }
    };
}

function frame(children: React.ReactNode, dock: React.ReactNode = <textarea aria-label="reply" />) {
    const view = render(
        <MessagesWrapper>
            <PolarThreadFrame fullPage={false} dock={dock}>
                {children}
            </PolarThreadFrame>
        </MessagesWrapper>
    );
    const node = view.container.querySelector<HTMLElement>("[role=log]")!;
    const content = node.firstElementChild as HTMLElement;
    return { view, node, content, ...geometry(node, content) };
}

beforeEach(() => {
    observers.length = 0;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});
afterEach(cleanup);

describe("a thread kept to its newest line", () => {
    it("stays at the end when a message is sent and more lines land before the pin's scroll event", () => {
        const thread = frame(<p>earlier</p>);
        thread.grow(0);
        expect(thread.atEnd()).toBe(true);
        // Sent: the bubble lands and the thread pins itself to the end.
        thread.grow(60);
        expect(thread.atEnd()).toBe(true);
        // The reply's steps land in the same frame, before that pin's scroll
        // event is delivered: the event sees the box far from the end.
        thread.box.height += 300;
        thread.scrollEvent();
        resized(thread.content);
        expect(thread.atEnd()).toBe(true);
        expect(thread.view.queryByRole("button", { name: /newest|latest|bottom|end/i })).toBeNull();
    });

    it("stays at the end when a running block folds and opens again around a mid-turn send", () => {
        const thread = frame(<p>earlier</p>);
        thread.grow(600);
        // Folded: the box shrinks and the browser clamps, firing a scroll.
        thread.box.height -= 400;
        thread.box.top = Math.min(thread.box.top, thread.box.height - thread.box.client);
        // Opened again before that event is delivered.
        thread.box.height += 400;
        thread.scrollEvent();
        resized(thread.content);
        expect(thread.atEnd()).toBe(true);
    });

    it("keeps the last line in view when the composer grows under the thread", () => {
        const thread = frame(<p>earlier</p>);
        thread.grow(200);
        expect(thread.atEnd()).toBe(true);
        // The dock takes 80px more: the thread's own box gets shorter.
        thread.box.client -= 80;
        resized(thread.node);
        expect(thread.atEnd()).toBe(true);
    });

    it("lets the person scroll up, and holds there while new lines land", () => {
        const thread = frame(<p>earlier</p>);
        thread.grow(600);
        fireEvent.wheel(thread.node, { deltaY: -120 });
        thread.box.top -= 300;
        thread.scrollEvent();
        const held = thread.box.top;
        thread.grow(200);
        expect(thread.box.top).toBe(held);
        expect(thread.atEnd()).toBe(false);
    });

    it("lets the person drag or key their way up too", () => {
        const thread = frame(<p>earlier</p>);
        thread.grow(600);
        fireEvent.keyDown(thread.node, { key: "PageUp" });
        thread.box.top -= 250;
        thread.scrollEvent();
        thread.grow(100);
        expect(thread.atEnd()).toBe(false);
    });

    it("follows again once the person scrolls back to the end", () => {
        const thread = frame(<p>earlier</p>);
        thread.grow(600);
        fireEvent.wheel(thread.node, { deltaY: -120 });
        thread.box.top -= 300;
        thread.scrollEvent();
        fireEvent.wheel(thread.node, { deltaY: 120 });
        thread.box.top = thread.box.height - thread.box.client;
        thread.scrollEvent();
        thread.grow(150);
        expect(thread.atEnd()).toBe(true);
    });
});
