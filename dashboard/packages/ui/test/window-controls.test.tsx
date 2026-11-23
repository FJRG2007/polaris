// @vitest-environment jsdom

/**
 * The desktop app draws the system's window buttons over the top right of the
 * page. The header has to show the same controls there as in a browser, each
 * one clickable, and nothing that opens pinned to the top of the window may
 * put its own top-right controls under the buttons (BUG-0025).
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { AppShell } from "../src/shell/app-shell";
import { afterEach, describe, expect, it } from "vitest";
import { clearWindowControls } from "../src/shell/window-controls";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "../src/components/dialog";

const TOKENS = join(__dirname, "../src/styles/tokens.css");
const BAND = "top-[var(--window-controls-height)]";

afterEach(() => {
    cleanup();
    delete (window as { polarisDesktop?: unknown; }).polarisDesktop;
});

function shell() {
    return render(
        <AppShell
            switcher={<button type="button">Apps</button>}
            search={<button type="button">Search</button>}
            account={
                <>
                    <button type="button">Updates</button>
                    <button type="button">Polar</button>
                    <button type="button">Notifications</button>
                    <button type="button">Account</button>
                </>
            }
        >
            <p>Page</p>
        </AppShell>
    );
}

function headerActions(): string[] {
    const header = screen.getByRole("banner");
    return within(header)
        .getAllByRole("button")
        .map((button) => button.textContent ?? "");
}

describe("the header in the desktop app", () => {
    it("renders the same actions with the desktop bridge present as without it", () => {
        shell();
        const web = headerActions();
        cleanup();
        (window as { polarisDesktop?: unknown; }).polarisDesktop = {};
        shell();
        expect(headerActions()).toEqual(web);
        expect(web).toEqual(["Apps", "Search", "Updates", "Polar", "Notifications", "Account"]);
    });

    it("keeps the account controls in the group that ends where the window buttons begin", () => {
        shell();
        const end = document.querySelector(".app-titlebar-end");
        expect(end).not.toBeNull();
        const names = within(end as HTMLElement)
            .getAllByRole("button")
            .map((button) => button.textContent);
        expect(names).toEqual(["Updates", "Polar", "Notifications", "Account"]);
    });

    it("cuts the left side at its own edge when the bar runs out of room, never under the controls", () => {
        shell();
        const left = screen.getByRole("banner").firstElementChild as HTMLElement;
        expect(left.className).toContain("min-w-0");
        expect(left.className).toContain("[overflow:clip]");
        expect(document.querySelector(".app-titlebar-end")?.className).toContain("shrink-0");
    });

    it("reserves the buttons' width and lets every item in the bar take the pointer", () => {
        const css = readFileSync(TOKENS, "utf8").replace(/\s+/g, " ");
        expect(css).toContain(
            "--window-controls-width: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));"
        );
        expect(css).toContain(".app-titlebar-end { padding-inline-end: var(--window-controls-width); }");
        // Every item of every group, a non-interactive one with a tooltip too.
        expect(css).toMatch(/\.app-titlebar > \* > \*, \.app-titlebar :is\( \[title\], a,[^{]*\) \{ app-region: no-drag; \}/);
    });
});

describe("clearWindowControls", () => {
    it("leaves a surface that is not pinned to the top alone", () => {
        expect(clearWindowControls("fixed left-1/2 top-1/2 max-h-[85vh]")).toBe("fixed left-1/2 top-1/2 max-h-[85vh]");
        expect(clearWindowControls(undefined)).toBe("");
    });

    it("moves a top-pinned edge below the band and takes the band off its full height", () => {
        const classes = clearWindowControls("right-0 top-0 h-full max-h-none").split(" ");
        expect(classes).toContain(BAND);
        expect(classes).toContain("h-[calc(100dvh-var(--window-controls-height))]");
        expect(classes).not.toContain("top-0");
        expect(classes).not.toContain("h-full");
    });

    it("keeps the bottom of an inset surface where it was", () => {
        const classes = clearWindowControls("fixed inset-0 z-50").split(" ");
        expect(classes).toEqual(expect.arrayContaining(["inset-0", BAND]));
    });

    it("follows a pin made only at a phone width, and leaves wider widths to the caller", () => {
        const classes = clearWindowControls("top-1/2 max-sm:top-0 max-sm:h-dvh sm:top-1/2").split(" ");
        expect(classes).toContain("max-sm:top-[var(--window-controls-height)]");
        expect(classes).toContain("max-sm:h-[calc(100dvh-var(--window-controls-height))]");
        expect(classes).toContain("top-1/2");
        expect(classes).toContain("sm:top-1/2");
    });

    it("takes the band off a base height at the width it is pinned at", () => {
        const classes = clearWindowControls("max-md:inset-0 h-dvh").split(" ");
        expect(classes).toContain("max-md:top-[var(--window-controls-height)]");
        expect(classes).toContain("max-md:h-[calc(100dvh-var(--window-controls-height))]");
        expect(classes).toContain("h-dvh");
    });
});

describe("a dialog pinned to the top of the window", () => {
    it("starts below the window buttons, with its own controls clear of them", () => {
        // The deploy service panel's own placement: bell, full screen and close
        // in its top-right corner.
        render(
            <Dialog open>
                <DialogContent className="right-0 left-auto top-0 flex h-full max-h-none translate-x-0 translate-y-0 flex-col">
                    <DialogTitle>Service</DialogTitle>
                </DialogContent>
            </Dialog>
        );
        const surface = screen.getByRole("dialog");
        expect(surface.className.split(" ")).toContain(BAND);
        expect(surface.className.split(" ")).not.toContain("top-0");
    });

    it("fills a phone below the band when it is a screen of its own there", () => {
        render(
            <Dialog open>
                <DialogContent className="max-w-3xl">
                    <DialogTitle>Wide</DialogTitle>
                </DialogContent>
            </Dialog>
        );
        expect(screen.getByRole("dialog").className.split(" ")).toContain("max-sm:top-[var(--window-controls-height)]");
    });

    it("stays centred where it is not pinned", () => {
        render(
            <Dialog open>
                <DialogContent>
                    <DialogTitle>Small</DialogTitle>
                </DialogContent>
            </Dialog>
        );
        const classes = screen.getByRole("dialog").className.split(" ");
        expect(classes).toContain("top-1/2");
        expect(classes).not.toContain(BAND);
    });
});
