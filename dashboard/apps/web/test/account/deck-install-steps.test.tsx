// @vitest-environment jsdom

/**
 * Installing Polaris on a deck: the app the reader's system points to comes
 * first, each app has its own steps, and each offers the file it installs.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { AppDownload } from "@/lib/app-releases";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeckFile } from "@/app/(app)/account/downloads/streamdeck-section";
import { DeckInstallSteps, detectDeckHost } from "@/app/(app)/account/downloads/deck-install-steps";

// The section's disconnect button reaches the API keys' server action, which
// these tests never press.
vi.mock("@/app/(app)/account/api-keys/actions", () => ({ revokeApiKeyAction: vi.fn() }));

// jsdom has no layout; the picker scrolls its chosen option into view.
Element.prototype.scrollIntoView ??= () => undefined;

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const RELEASE: AppDownload = {
    url: "https://github.com/example/polaris/releases/tag/streamdeck-v0.2.0",
    version: "streamdeck-v0.2.0",
    files: [
        { name: "notes.txt", url: "https://example.test/notes.txt" },
        { name: "polaris.streamDeckPlugin", url: "https://example.test/polaris.streamDeckPlugin" },
        { name: "polaris-0.2.0.tgz", url: "https://example.test/polaris-0.2.0.tgz" }
    ]
} as unknown as AppDownload;

function steps(userAgent: string) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    render(
        <DeckInstallSteps
            address="https://polaris.example.com"
            pluginFile={<a href="/plugin">plugin file</a>}
            moduleFile={<a href="/module">module file</a>}
        />,
        { wrapper: MessagesWrapper }
    );
}

describe("the app a deck is installed in", () => {
    it("is OpenDeck on Linux and the Stream Deck app everywhere else", () => {
        expect(detectDeckHost("Mozilla/5.0 (X11; Linux x86_64)")).toBe("opendeck");
        expect(detectDeckHost("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("streamdeck");
        expect(detectDeckHost("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
            "streamdeck"
        );
    });

    it("walks the Stream Deck app through the plugin and the Connect key", () => {
        steps("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        expect(screen.getByRole("link", { name: "plugin file" })).toBeTruthy();
        expect(screen.queryByRole("link", { name: "module file" })).toBeNull();
        expect(screen.getByText("Connect")).toBeTruthy();
        expect(screen.queryByText("Install from file")).toBeNull();
    });

    it("tells OpenDeck on Linux what Node.js it needs and where its file button is", () => {
        steps("Mozilla/5.0 (X11; Linux x86_64)");
        expect(screen.getByText(/Node\.js 20 or newer/)).toBeTruthy();
        expect(screen.getByText(/Flatpak is not used/)).toBeTruthy();
        expect(screen.getByRole("link", { name: "nodejs.org" }).getAttribute("href")).toBe(
            "https://nodejs.org/en/download"
        );
        expect(screen.getByText("Plugins")).toBeTruthy();
        expect(screen.getByText("Install from file")).toBeTruthy();
        expect(screen.getByRole("link", { name: "plugin file" })).toBeTruthy();
    });

    it("offers Companion its module, its import button and this Polaris's address", async () => {
        steps("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        fireEvent.click(screen.getByRole("combobox", { name: "Where you install it" }));
        fireEvent.click(await screen.findByRole("option", { name: "Bitfocus Companion" }));
        expect(screen.getByRole("link", { name: "module file" })).toBeTruthy();
        expect(screen.queryByRole("link", { name: "plugin file" })).toBeNull();
        expect(screen.getByText("Import module package")).toBeTruthy();
        expect(screen.getByText("https://polaris.example.com")).toBeTruthy();
        expect(screen.getByText(/Companion 5\.0 or newer/)).toBeTruthy();
        // Its pages are open to the network by default, and so would the keys be.
        expect(screen.getByText("Admin UI Password")).toBeTruthy();
        // It acts as the reader, and is disconnected where their decks are.
        expect(screen.getByText(/It uses your account/)).toBeTruthy();
        expect(screen.getByText("Advanced")).toBeTruthy();
    });

    it("never offers a choice that does not work yet", async () => {
        steps("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        fireEvent.click(screen.getByRole("combobox", { name: "Where you install it" }));
        const options = await screen.findAllByRole("option");
        expect(options.map((option) => option.textContent)).toEqual([
            "Stream Deck app",
            "OpenDeck",
            "Bitfocus Companion"
        ]);
    });
});

describe("the file each choice downloads", () => {
    it("is the release's file of that kind, named by its version", () => {
        render(<DeckFile download={RELEASE} suffix=".tgz" />, { wrapper: MessagesWrapper });
        const link = screen.getByRole("link");
        expect(link.getAttribute("href")).toBe("https://example.test/polaris-0.2.0.tgz");
        expect(link.textContent).toContain("streamdeck-v0.2.0");
    });

    it("says nothing is published when the release has no such file", () => {
        render(<DeckFile download={{ ...RELEASE, files: [] }} suffix=".tgz" />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.getByText("No version has been published yet.")).toBeTruthy();
    });
});
