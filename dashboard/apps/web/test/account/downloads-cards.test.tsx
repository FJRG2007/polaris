// @vitest-environment jsdom

/**
 * The downloads screen as cards: each thing it offers is a card of rows, one
 * per place it runs, and each row's long instructions open from it instead of
 * filling the card. Nothing the old screen offered is gone - every browser's
 * steps, the line that installs the extension, its files, the link that
 * connects it, and a guide for each assistant.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { MessagesWrapper } from "../setup/i18n";
import { BROWSER_GUIDES } from "@/lib/browser-guide";
import { CLIENT_GUIDES } from "@/lib/mcp/client-guides";
import { afterEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { ExtensionCard } from "@/app/(app)/account/downloads/extension-card";
import { AssistantsCard, FEATURED_ASSISTANTS } from "@/app/(app)/account/downloads/assistants-card";

// What jsdom does not implement and the pickers call on the way open.
Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined
});

afterEach(cleanup);

const SRC = `${join(__dirname, "..", "..", "src")}/`;

function extensionCard() {
    render(
        <ExtensionCard
            repo="example-org/example-repo"
            files={<a href="/files">release files</a>}
        />,
        {
            wrapper: MessagesWrapper
        }
    );
}

describe("the extension card", () => {
    it("picks a browser, offers every one with its mark, and shows the store as not there yet", async () => {
        extensionCard();
        await userEvent.click(
            screen.getByRole("combobox", { name: "Which browser you are loading it into" })
        );
        for (const guide of BROWSER_GUIDES)
            expect(await screen.findByRole("option", { name: guide.label })).toBeTruthy();
        await userEvent.keyboard("{Escape}");
        // The store is a choice that cannot be made yet, and says why.
        const store = screen.getByRole("radio", { name: "Store" });
        expect(store.hasAttribute("disabled")).toBe(true);
        expect(
            screen.getByRole("link", { name: "Connect it to this account" }).getAttribute("href")
        ).toBe("/account/extension");
    });

    it("starts a Chromium browser on the line that keeps it current, and has the files and steps under Download", async () => {
        extensionCard();
        expect(screen.getByText("One line, and it keeps itself up to date")).toBeTruthy();
        expect(screen.queryByRole("link", { name: "release files" })).toBeNull();
        await userEvent.click(screen.getByRole("radio", { name: "Download" }));
        expect(screen.getByRole("link", { name: "release files" })).toBeTruthy();
        expect(screen.getByText("chrome://extensions")).toBeTruthy();
        expect(screen.getByText("Developer mode")).toBeTruthy();
    });

    it("gives Firefox its steps and files but no line, which cannot keep it current", async () => {
        extensionCard();
        await userEvent.click(
            screen.getByRole("combobox", { name: "Which browser you are loading it into" })
        );
        await userEvent.click(await screen.findByRole("option", { name: "Firefox" }));
        expect(await screen.findByText("about:debugging#/runtime/this-firefox")).toBeTruthy();
        expect(screen.queryByText("One line, and it keeps itself up to date")).toBeNull();
        expect(screen.getByRole("radio", { name: "Command" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("link", { name: "release files" })).toBeTruthy();
    });

    it("offers the app's Install button on every browser but Firefox", async () => {
        const desktop = window as { polarisDesktop?: unknown };
        desktop.polarisDesktop = { platform: "win32", installTool: async () => ({ ok: true }) };
        try {
            extensionCard();
            expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
            await userEvent.click(
                screen.getByRole("combobox", { name: "Which browser you are loading it into" })
            );
            await userEvent.click(await screen.findByRole("option", { name: "Firefox" }));
            await screen.findByText("about:debugging#/runtime/this-firefox");
            expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
        } finally {
            delete desktop.polarisDesktop;
        }
    });
});

describe("the assistants card", () => {
    it("links each featured assistant to its own guide, and to the full list", () => {
        render(<AssistantsCard />, { wrapper: MessagesWrapper });
        for (const id of FEATURED_ASSISTANTS) {
            const guide = CLIENT_GUIDES.find((entry) => entry.id === id)!;
            expect(
                screen.getByRole("link", { name: `Connect ${guide.name}` }).getAttribute("href")
            ).toBe(`/account/assistants#connect-${id}`);
        }
        expect(
            screen
                .getByRole("link", { name: `See all ${CLIENT_GUIDES.length} assistants` })
                .getAttribute("href")
        ).toBe("/account/assistants#connect");
    });

    it("only features clients that have a guide", () => {
        for (const id of FEATURED_ASSISTANTS)
            expect(CLIENT_GUIDES.some((guide) => guide.id === id)).toBe(true);
    });
});

describe("the page", () => {
    it("draws every card, the wide one first", async () => {
        const source =
            await // The page and the shared layout it renders, which the public site draws too.
            Promise.all([
                readFile(`${SRC}app/(app)/account/downloads/page.tsx`, "utf8"),
                readFile(
                    `${SRC}../../../packages/ui/src/downloads/account/downloads-page.tsx`,
                    "utf8"
                )
            ]).then((parts) => parts.join(" "));
        for (const card of [
            'id="app"',
            "<ExtensionCard",
            "<StreamDeckSection",
            "<CliSection",
            "<AssistantsCard",
            'id="desktop"',
            'id="mobile"'
        ])
            expect(source).toContain(card);
        expect(source.indexOf('id="desktop"')).toBeLessThan(source.indexOf("<ExtensionCard"));
        expect(source).toContain('className="lg:col-span-2"');
    });

    it("installs from the browser as a row of the desktop card, with the TV card next", async () => {
        const layout = await readFile(
            `${SRC}../../../packages/ui/src/downloads/account/downloads-page.tsx`,
            "utf8"
        );
        const desktop = layout.indexOf('id="desktop"');
        const app = layout.indexOf('id="app"');
        const tv = layout.indexOf("{tv ?? (");
        // Inside the desktop card, before it closes.
        expect(app).toBeGreaterThan(desktop);
        expect(app).toBeLessThan(layout.indexOf("</DownloadCard>", desktop));
        expect(layout.slice(app, tv)).toContain("<DownloadRow");
        // The place it freed goes to the TV, ahead of every other card.
        expect(tv).toBeGreaterThan(app);
        expect(tv).toBeLessThan(layout.indexOf("<ExtensionCard"));
        // A page with no TV slot, the public site, still draws the card.
        expect(layout.slice(tv)).toContain('id="tv"');
    });

    it("offers no download for a phone, only the plain fact that it is planned", async () => {
        const source =
            await // The page and the shared layout it renders, which the public site draws too.
            Promise.all([
                readFile(`${SRC}app/(app)/account/downloads/page.tsx`, "utf8"),
                readFile(
                    `${SRC}../../../packages/ui/src/downloads/account/downloads-page.tsx`,
                    "utf8"
                )
            ]).then((parts) => parts.join(" "));
        const mobile = source.slice(source.indexOf('id="mobile"'));
        expect(mobile).toContain('t("downloads.mobile.planned")');
        expect(mobile).not.toContain("href=");
    });
});
