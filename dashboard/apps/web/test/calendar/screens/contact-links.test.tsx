// @vitest-environment jsdom

/**
 * The links an event shows can be acted on: an address opens a new message in
 * Polaris Mail for somebody with Mail and the device's mail app otherwise, a
 * web link opens in a new tab and nothing else, a right-click offers the action
 * and a copy, and a copy is confirmed. A location that is a meeting link is
 * also offered as Join.
 */

import "@/components/app-host/client";
import type { ReactNode } from "react";
import { MessagesWrapper } from "../../setup/i18n";
import { Linkified } from "@polaris-app/calendar/src/screens/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
    ContactLinksProvider,
    LocationLine,
    type ContactLinks
} from "@polaris-app/calendar/src/screens/contact-links";

vi.mock("@polaris-app/calendar/src/actions/mail", () => ({
    mailComposeAction: async () => ({ ok: true, compose: true })
}));

const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText }
    });
});

afterEach(cleanup);

function renderWith(node: ReactNode, links?: ContactLinks) {
    return render(
        links ? <ContactLinksProvider value={links}>{node}</ContactLinksProvider> : node,
        {
            wrapper: MessagesWrapper
        }
    );
}

const TEXT = "Join https://meet.example.test/abc or write to ana@example.test";

function rightClick(element: Element): void {
    act(() => {
        fireEvent.pointerDown(element, { button: 2, pointerType: "mouse" });
        fireEvent.contextMenu(element, { clientX: 20, clientY: 20 });
    });
}

describe("an address in an event's text", () => {
    it("opens a new message in Polaris Mail for somebody with Mail", () => {
        renderWith(<Linkified text={TEXT} />, { compose: true, notify: vi.fn() });
        const link = screen.getByRole("link", { name: "ana@example.test" });
        expect(link.getAttribute("href")).toBe("/mail/compose?url=mailto%3Aana%2540example.test");
        expect(link.getAttribute("target")).toBeNull();
    });

    it("is a mailto: link where there is no Mail (a public page)", () => {
        renderWith(<Linkified text={TEXT} />);
        const link = screen.getByRole("link", { name: "ana@example.test" });
        expect(link.getAttribute("href")).toBe("mailto:ana%40example.test");
    });

    it("offers sending and copying on a right-click, and confirms the copy", async () => {
        const notify = vi.fn();
        renderWith(<Linkified text={TEXT} />, { compose: true, notify });
        rightClick(screen.getByRole("link", { name: "ana@example.test" }));
        const menu = screen.getByRole("menu", { name: "Actions for this address" });
        expect(
            within(menu)
                .getAllByRole("menuitem")
                .map((item) => item.textContent)
        ).toEqual(["Send email", "Copy email address"]);
        expect(
            within(menu).getByRole("menuitem", { name: "Send email" }).getAttribute("href")
        ).toBe("/mail/compose?url=mailto%3Aana%2540example.test");
        await act(async () => {
            fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy email address" }));
        });
        expect(writeText).toHaveBeenCalledWith("ana@example.test");
        expect(notify).toHaveBeenCalledWith("Email address copied");
    });

    it("says a copy happened beside the link when the page has no toast", async () => {
        renderWith(<Linkified text={TEXT} />);
        rightClick(screen.getByRole("link", { name: "ana@example.test" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitem", { name: "Copy email address" }));
        });
        expect(screen.getByRole("status").textContent).toBe("Email address copied");
    });

    it("says so when the browser refuses the copy", async () => {
        writeText.mockRejectedValue(new Error("denied"));
        const notify = vi.fn();
        renderWith(<Linkified text={TEXT} />, { compose: false, notify });
        rightClick(screen.getByRole("link", { name: "ana@example.test" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("menuitem", { name: "Copy email address" }));
        });
        expect(notify).toHaveBeenCalledWith("Couldn't copy. Select the text and copy it instead.");
    });
});

describe("a web link in an event's text", () => {
    it("opens in a new tab without handing over the page", () => {
        renderWith(<Linkified text={TEXT} />);
        const link = screen.getByRole("link", { name: "https://meet.example.test/abc" });
        expect(link.getAttribute("href")).toBe("https://meet.example.test/abc");
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("offers opening and copying on a right-click", async () => {
        const notify = vi.fn();
        renderWith(<Linkified text={TEXT} />, { compose: true, notify });
        rightClick(screen.getByRole("link", { name: "https://meet.example.test/abc" }));
        const menu = screen.getByRole("menu", { name: "Actions for this link" });
        const open = within(menu).getByRole("menuitem", { name: "Open link" });
        expect(open.getAttribute("href")).toBe("https://meet.example.test/abc");
        expect(open.getAttribute("rel")).toBe("noopener noreferrer");
        await act(async () => {
            fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
        });
        expect(writeText).toHaveBeenCalledWith("https://meet.example.test/abc");
        expect(notify).toHaveBeenCalledWith("Link copied");
    });

    it("leaves anything that is not a web address as text", () => {
        renderWith(<Linkified text="javascript:alert(1) and data:text/html,x" />);
        expect(screen.queryByRole("link")).toBeNull();
    });
});

describe("an event's location", () => {
    it("links a meeting URL and offers Join for it", () => {
        renderWith(<LocationLine location="https://meet.google.com/abc-defg-hij" conference="" />);
        expect(
            screen.getByRole("link", { name: "https://meet.google.com/abc-defg-hij" })
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "Join meeting" }).getAttribute("href")).toBe(
            "https://meet.google.com/abc-defg-hij"
        );
    });

    it("does not offer Join twice when the conference is the same link", () => {
        renderWith(
            <LocationLine
                location="https://meet.google.com/abc-defg-hij"
                conference="https://meet.google.com/abc-defg-hij"
            />
        );
        expect(screen.queryByRole("link", { name: "Join meeting" })).toBeNull();
    });

    it("keeps a place as text, with an address in it still a link", () => {
        renderWith(<LocationLine location="Room 4 - ask desk@example.test" conference="" />);
        expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
            "desk@example.test"
        ]);
    });
});
