// @vitest-environment jsdom

/**
 * A submenu in a window too narrow for two menus side by side - a phone, the
 * extension's side panel at its 320 px minimum. Radix only moves a submenu up
 * and down to keep it on screen, so it was drawn half off the right edge with
 * nothing to bring it back: Polar's microphone list could not be reached.
 */

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@polaris/ui";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { submenuFit } from "../../../../packages/ui/src/lib/submenu-fit";

afterEach(cleanup);

const box = (left: number, width: number) => ({ left, right: left + width, width, height: 32 });

describe("submenuFit", () => {
    it("leaves a submenu beside its menu when one side has room", () => {
        expect(submenuFit(box(16, 256), 1280, 16, 192)).toBeNull();
        // No room on the right, room on the left: Radix flips it there itself.
        expect(submenuFit(box(1000, 256), 1280, 16, 192)).toBeNull();
    });

    it("lays it over its menu, under the trigger, when neither side has room", () => {
        expect(submenuFit(box(16, 256), 320, 16, 192)).toEqual({
            sideOffset: -244,
            alignOffset: 32
        });
        expect(submenuFit(box(20, 300), 400, 16, 192)).not.toBeNull();
    });
});

/** Where floating-ui put the submenu: its wrapper's translate. */
function placedAt(content: HTMLElement): number {
    const wrapper = content.closest<HTMLElement>("[data-radix-popper-content-wrapper]");
    const match = /translate\((-?[\d.]+)px/.exec(wrapper?.style.transform ?? "");
    return match ? Number(match[1]) : Number.NaN;
}

function Menu() {
    return (
        <DropdownMenu defaultOpen>
            <DropdownMenuTrigger>Microphone</DropdownMenuTrigger>
            <DropdownMenuContent className="w-64">
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Input</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64" data-testid="sub">
                        <DropdownMenuItem>Default</DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

async function openAt(viewport: number): Promise<number> {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport });
    // jsdom lays nothing out; the window floating-ui keeps the menu inside is
    // the root's box, and the submenu itself is the 192 px it is drawn at least.
    document.documentElement.getBoundingClientRect = () =>
        ({
            left: 0,
            top: 0,
            right: viewport,
            bottom: 800,
            width: viewport,
            height: 800
        }) as DOMRect;
    render(<Menu />);
    const trigger = await screen.findByRole("menuitem", { name: "Input" });
    trigger.getBoundingClientRect = () =>
        ({ ...box(16, 256), top: 100, bottom: 132, x: 16, y: 100, toJSON() {} }) as DOMRect;
    trigger.focus();
    await userEvent.keyboard("{ArrowRight}");
    const sub = await screen.findByTestId("sub");
    sub.getBoundingClientRect = () => ({ ...box(0, 192), top: 0, bottom: 64 }) as DOMRect;
    await new Promise((settle) => setTimeout(settle, 50));
    return placedAt(sub);
}

describe("a dropdown's submenu", () => {
    it("opens over its menu, inside a 320 px window", async () => {
        const x = await openAt(320);
        // A step in from the trigger's leading edge, not past its right one.
        expect(x).toBe(16 + 12);
    });

    it("still opens beside its menu where there is room", async () => {
        expect(await openAt(1280)).toBe(16 + 256);
    });
});
