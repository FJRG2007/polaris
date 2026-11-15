// @vitest-environment jsdom

/**
 * Labels in any language's length.
 *
 * A German, Finnish or Russian translation runs 30-60% longer than the English
 * it replaces, and a layout that only fits because a translation was shortened
 * is a layout that breaks in the next language somebody adds. jsdom draws no
 * boxes, so what this pins is the structure that makes the browser give way:
 * the text of each shared control sits in an element that can end in an
 * ellipsis (or wrap), with the whole of it in `title` once it is cut, and the
 * row around it is allowed to be narrower than its content.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Badge, Button, SegmentedControl, SelectRoot, SelectTrigger, SelectValue } from "@polaris/ui";

vi.mock("next/navigation", () => ({ usePathname: () => "/account/sessions" }));
vi.mock("@/app/(app)/launcher-waiting-actions", () => ({
    markLauncherReadAction: async () => ({})
}));
vi.mock("@/components/notifications/notifications-provider", () => ({
    useHoldConversationNotices: () => () => ({ settle: () => undefined, abandon: () => undefined })
}));

const { AppSidebar } = await import("@/components/app-sidebar");

afterEach(cleanup);

// About two and a half times "Run in background", which is what the longest
// translations of a short English label come to.
const LONG = "Im Hintergrund weiterlaufen lassen, bis es fertig ist";

/** The element that holds `text` must be able to give way: an ellipsis on
 *  overflow, or wrapping. */
function expectGivesWay(element: HTMLElement) {
    const classes = element.className.split(/\s+/);
    const ellipsis =
        classes.includes("truncate") ||
        (classes.includes("overflow-hidden") && classes.includes("text-ellipsis"));
    const wraps = classes.includes("whitespace-normal") || classes.includes("break-words");
    expect(ellipsis || wraps, `"${element.className}" neither truncates nor wraps`).toBe(true);
    expect(classes).toContain("min-w-0");
}

function holder(text: string): HTMLElement {
    return screen.getByText(text, { selector: "span" });
}

/** jsdom lays nothing out, so the cut is described: wider content than box. */
function hoverCut(label: HTMLElement, cut = true) {
    Object.defineProperty(label, "scrollWidth", { configurable: true, value: cut ? 400 : 100 });
    Object.defineProperty(label, "clientWidth", { configurable: true, value: 100 });
    fireEvent.pointerEnter(label);
}

describe("a label longer than its control", () => {
    it("ends a badge in an ellipsis, never wider than its row", () => {
        render(<Badge>{LONG}</Badge>);
        const label = holder(LONG);
        expectGivesWay(label);
        // No tooltip repeating a label that fits; the whole of it once it is cut.
        hoverCut(label, false);
        expect(label.hasAttribute("title")).toBe(false);
        hoverCut(label);
        expect(label.title).toBe(LONG);
        expect(label.parentElement?.className).toContain("max-w-full");
        expect(label.parentElement?.className).toContain("min-w-0");
    });

    it("ends a button in an ellipsis and keeps its icon whole", () => {
        render(
            <Button>
                <svg aria-hidden />
                {LONG}
            </Button>
        );
        const label = holder(LONG);
        expectGivesWay(label);
        hoverCut(label);
        expect(label.title).toBe(LONG);
        const button = screen.getByRole("button", { name: LONG });
        expect(button.className).toContain("max-w-full");
        // The icon rule is the button's, untouched: icons never shrink.
        expect(button.className).toContain("[&_svg]:shrink-0");
    });

    it("leaves a control's own title in charge of its tooltip", () => {
        render(<Badge title="What this state means">{LONG}</Badge>);
        const label = holder(LONG);
        hoverCut(label);
        expect(label.hasAttribute("title")).toBe(false);
    });

    it("keeps a run of text and a value in one label", () => {
        render(<Button>Delete {"project-with-a-long-name"}</Button>);
        const label = holder("Delete project-with-a-long-name");
        expectGivesWay(label);
    });

    it("lets a button that opted into wrapping still wrap", () => {
        render(<Button className="h-auto whitespace-normal">{LONG}</Button>);
        const label = holder(LONG);
        // The label sets no white-space of its own, so the button's applies.
        expect(label.className).not.toContain("truncate");
        expect(label.className).not.toContain("whitespace-nowrap");
    });

    it("ends a tab longer than the strip in an ellipsis", () => {
        render(
            <SegmentedControl
                aria-label="Tabs"
                value="a"
                onValueChange={() => undefined}
                options={[
                    { value: "a", label: LONG },
                    { value: "b", label: "Logs" }
                ]}
            />
        );
        const label = holder(LONG);
        expectGivesWay(label);
        hoverCut(label);
        expect(label.title).toBe(LONG);
        // The option itself never shrinks (the track scrolls); only one longer
        // than the whole track is capped.
        const tab = screen.getByRole("radio", { name: LONG });
        expect(tab.className).toContain("max-w-full");
    });

    it("clips a select's value at the chevron", () => {
        render(
            <SelectRoot value="x">
                <SelectTrigger aria-label="Choice">
                    <SelectValue placeholder={LONG} />
                </SelectTrigger>
            </SelectRoot>
        );
        const trigger = screen.getByRole("combobox");
        expect(trigger.className).toContain("[&>span]:min-w-0");
        expect(trigger.className).toContain("[&>span]:truncate");
        // A bare-text value is a block, so its ellipsis can apply.
        expect(trigger.className).toContain("[&>span:not(:has(>*))]:!block");
        expect(trigger.className).toContain("[&>span>span]:truncate");
    });

    it("truncates every rail entry inside a row that can shrink", () => {
        const host = document.createElement("div");
        host.innerHTML = renderToStaticMarkup(<AppSidebar />);
        const links = [...host.querySelectorAll<HTMLAnchorElement>("a[href^='/account']")];
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
            expect(link.className.split(/\s+/)).toContain("min-w-0");
            const label = link.querySelector<HTMLElement>("span[title]");
            expect(label, link.outerHTML).not.toBeNull();
            expect(label!.className.split(/\s+/)).toContain("truncate");
            expect(label!.title).toBe(label!.textContent);
        }
    });
});
