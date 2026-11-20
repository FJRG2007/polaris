// @vitest-environment jsdom

/**
 * A finger sliding along the bottom tab bar, the way iOS's does: the tab under
 * it lights up, lifting opens it, sliding far above the bar opens nothing, and
 * a plain tap is still the button's own click - once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BottomTabs, type BottomTab } from "../src/components/bottom-tabs";

const WIDTH = 80;

function rect(left: number, width: number, top = 700, height = 56): DOMRect {
    return { left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function bar(selected: string[]) {
    const tabs: BottomTab[] = ["home", "chat", "drive", "you"].map((id) => ({
        id,
        label: id,
        icon: null,
        active: id === "home",
        onSelect: () => selected.push(id)
    }));
    render(<BottomTabs tabs={tabs} label="Places" />);
    const nav = screen.getByRole("navigation");
    nav.getBoundingClientRect = () => rect(0, WIDTH * 4);
    screen.getAllByRole("button").forEach((button, index) => {
        button.getBoundingClientRect = () => rect(index * WIDTH, WIDTH);
    });
    nav.setPointerCapture = vi.fn();
    return nav;
}

const finger = { pointerId: 1, pointerType: "touch", isPrimary: true };

afterEach(cleanup);

describe("sliding along the bottom tab bar", () => {
    it("opens the tab the finger is lifted on, and lights it on the way", () => {
        const selected: string[] = [];
        const nav = bar(selected);
        fireEvent.pointerDown(nav, { ...finger, clientX: 10, clientY: 720 });
        fireEvent.pointerMove(nav, { ...finger, clientX: 170, clientY: 720 });
        expect(screen.getByRole("button", { name: "drive" }).hasAttribute("data-under")).toBe(true);
        fireEvent.pointerUp(nav, { ...finger, clientX: 170, clientY: 720 });
        // The click a browser may still send for the same lift is not a second press.
        fireEvent.click(screen.getByRole("button", { name: "drive" }));
        expect(selected).toEqual(["drive"]);
        expect(screen.getByRole("button", { name: "drive" }).hasAttribute("data-under")).toBe(false);
    });

    it("opens nothing when the finger is lifted well above the bar", () => {
        const selected: string[] = [];
        const nav = bar(selected);
        fireEvent.pointerDown(nav, { ...finger, clientX: 10, clientY: 720 });
        fireEvent.pointerMove(nav, { ...finger, clientX: 250, clientY: 720 });
        fireEvent.pointerUp(nav, { ...finger, clientX: 250, clientY: 500 });
        expect(selected).toEqual([]);
    });

    it("takes a thumb that overshoots the last tab as the last tab", () => {
        const selected: string[] = [];
        const nav = bar(selected);
        fireEvent.pointerDown(nav, { ...finger, clientX: 10, clientY: 720 });
        fireEvent.pointerMove(nav, { ...finger, clientX: 400, clientY: 720 });
        fireEvent.pointerUp(nav, { ...finger, clientX: 400, clientY: 720 });
        expect(selected).toEqual(["you"]);
    });

    it("leaves a tap, and a mouse, to the button's own click", () => {
        const selected: string[] = [];
        const nav = bar(selected);
        const chat = screen.getByRole("button", { name: "chat" });
        fireEvent.pointerDown(chat, { ...finger, clientX: 100, clientY: 720 });
        fireEvent.pointerUp(chat, { ...finger, clientX: 102, clientY: 720 });
        fireEvent.click(chat);
        fireEvent.pointerDown(nav, { pointerId: 2, pointerType: "mouse", isPrimary: true, clientX: 10, clientY: 720 });
        fireEvent.pointerMove(nav, { pointerId: 2, pointerType: "mouse", isPrimary: true, clientX: 170, clientY: 720 });
        fireEvent.pointerUp(nav, { pointerId: 2, pointerType: "mouse", isPrimary: true, clientX: 170, clientY: 720 });
        expect(selected).toEqual(["chat"]);
    });
});
