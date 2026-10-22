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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExtensionCard } from "@/app/(app)/account/downloads/extension-card";
import { AssistantsCard, FEATURED_ASSISTANTS } from "@/app/(app)/account/downloads/assistants-card";

// jsdom has no layout; the pickers scroll their chosen option into view.
Element.prototype.scrollIntoView ??= () => undefined;

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
    it("has a row per browser, each with its own mark", () => {
        extensionCard();
        for (const guide of BROWSER_GUIDES) {
            expect(screen.getByText(guide.label)).toBeTruthy();
            expect(screen.getByRole("button", { name: `Install in ${guide.label}` })).toBeTruthy();
        }
        // The store row says plainly that it is not there yet.
        expect(screen.getByText("From your browser's store")).toBeTruthy();
        expect(screen.getByText("Not there yet")).toBeTruthy();
        expect(
            screen.getByRole("link", { name: "Connect it to this account" }).getAttribute("href")
        ).toBe("/account/extension");
    });

    it("opens a Chromium browser's steps with that browser picked, the line and the files", async () => {
        extensionCard();
        fireEvent.click(screen.getByRole("button", { name: "Install in Edge" }));
        expect(await screen.findByText("edge://extensions")).toBeTruthy();
        expect(screen.getByText("One line, and it keeps itself up to date")).toBeTruthy();
        expect(screen.getByRole("link", { name: "release files" })).toBeTruthy();
        expect(screen.getByText("Developer mode")).toBeTruthy();
    });

    it("gives Firefox its steps and files but no line, which cannot keep it current", async () => {
        extensionCard();
        fireEvent.click(screen.getByRole("button", { name: "Install in Firefox" }));
        expect(await screen.findByText("about:debugging#/runtime/this-firefox")).toBeTruthy();
        expect(screen.queryByText("One line, and it keeps itself up to date")).toBeNull();
        expect(screen.getByRole("link", { name: "release files" })).toBeTruthy();
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
        expect(source.indexOf('id="app"')).toBeLessThan(source.indexOf("<ExtensionCard"));
        expect(source).toContain('className="lg:col-span-2"');
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
