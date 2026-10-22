// @vitest-environment jsdom

/**
 * Installing Polaris on a deck: the app the reader's system points to comes
 * first, each app has its own steps, and each offers the file it installs.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { AppDownload } from "@/lib/app-releases";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeckFile, StreamDeckSection } from "@/app/(app)/account/downloads/streamdeck-section";
import {
    DeckHostMark,
    DeckInstallSteps,
    detectDeckHost
} from "@/app/(app)/account/downloads/deck-install-steps";

// The section's disconnect button reaches the API keys' server action, which
// these tests never press.
vi.mock("@/app/(app)/account/api-keys/actions", () => ({ revokeApiKeyAction: vi.fn() }));

const marketplace = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("@/lib/deck/marketplace", () => ({
    get STREAMDECK_MARKETPLACE_URL() {
        return marketplace.url;
    }
}));

// jsdom has no layout; the picker scrolls its chosen option into view.
Element.prototype.scrollIntoView ??= () => undefined;

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    marketplace.url = null;
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

/** The card's own props, with stand-ins for the downloads that wait on GitHub. */
const SECTION = {
    decks: [],
    address: "https://polaris.example.com",
    repo: "example-org/example-repo",
    pluginFile: <a href="/plugin">plugin file</a>,
    moduleFile: <a href="/module">module file</a>
};

function steps(userAgent: string, address: string | null = "https://polaris.example.com") {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    render(
        <DeckInstallSteps
            address={address}
            repo="example-org/example-repo"
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

    it("takes somebody new to the Stream Deck app from the actions list to a working key", () => {
        steps("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        // Where the plugin's actions are, and what the action is called there.
        expect(screen.getByText(/actions list on the right/)).toBeTruthy();
        expect(screen.getByText("Polaris")).toBeTruthy();
        // Dragged from the list, then picked in the key's settings.
        expect(screen.getAllByText("Action", { selector: "b" })).toHaveLength(2);
        // Where a key's settings open, and the address they ask for.
        expect(screen.getByText(/bottom of the window/)).toBeTruthy();
        expect(screen.getByText("Address")).toBeTruthy();
        expect(screen.getByText("https://polaris.example.com")).toBeTruthy();
        expect(screen.getByText(/approve it/)).toBeTruthy();
        expect(screen.getByText(/choose what it does/)).toBeTruthy();
    });

    it("offers the one-line install for the system the reader is on", () => {
        steps("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
        expect(
            screen.getByText(
                /curl -fsSL .*\/example-org\/example-repo\/main\/dashboard\/apps\/streamdeck\/scripts\/install\.sh \| sh/
            )
        ).toBeTruthy();
        cleanup();
        steps("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        expect(screen.getByText(/^irm .*streamdeck\/scripts\/install\.ps1 \| iex$/)).toBeTruthy();
    });

    it("offers no line for OpenDeck, whose plugins folder is not documented", () => {
        steps("Mozilla/5.0 (X11; Linux x86_64)");
        expect(screen.queryByText(/streamdeck\/scripts\/install/)).toBeNull();
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

    it("gives Companion the address this page is on when none is configured", async () => {
        steps("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", null);
        fireEvent.click(screen.getByRole("combobox", { name: "Where you install it" }));
        fireEvent.click(await screen.findByRole("option", { name: "Bitfocus Companion" }));
        expect(screen.getByText(window.location.origin)).toBeTruthy();
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

describe("the Elgato Marketplace row", () => {
    it("says the plugin is not there yet, and links nothing until it is", () => {
        render(<StreamDeckSection {...SECTION} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("From the Elgato Marketplace")).toBeTruthy();
        expect(screen.getByText("Not there yet")).toBeTruthy();
        expect(screen.queryByRole("link", { name: "Open in Marketplace" })).toBeNull();
        expect(screen.getByText("Install it yourself")).toBeTruthy();
    });

    it("links the listing once it has an address", () => {
        marketplace.url = "https://marketplace.example.test/polaris";
        render(<StreamDeckSection {...SECTION} />, { wrapper: MessagesWrapper });
        expect(screen.queryByText("Not there yet")).toBeNull();
        expect(screen.getByRole("link", { name: "Open in Marketplace" }).getAttribute("href")).toBe(
            "https://marketplace.example.test/polaris"
        );
    });
});

describe("the Stream Deck card", () => {
    it("lists each app a deck runs on with its own mark, and opens that app's steps", async () => {
        render(<StreamDeckSection {...SECTION} />, { wrapper: MessagesWrapper });
        for (const name of ["Stream Deck app", "OpenDeck", "Bitfocus Companion"])
            expect(screen.getByText(name)).toBeTruthy();
        expect(screen.getByText("Linux, Windows and macOS")).toBeTruthy();
        // Nothing is drawn until a row is pressed: the card stays a list.
        expect(screen.queryByText("Import module package")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Install in Bitfocus Companion" }));
        // The row's app is already picked in the steps it opens.
        expect(await screen.findByText("Import module package")).toBeTruthy();
        expect(screen.getByRole("link", { name: "module file" })).toBeTruthy();
        expect(screen.getByText("https://polaris.example.com")).toBeTruthy();
    });

    it("keeps the connected decks and the button that disconnects each", () => {
        const deck = {
            id: "key-1",
            name: "Office deck",
            createdAt: "2026-01-01T00:00:00Z",
            lastUsedAt: null
        };
        render(<StreamDeckSection {...SECTION} decks={[deck]} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Connected decks")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Office deck" }).getAttribute("href")).toBe(
            "/account/api-keys/key-1"
        );
        expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    });

    it("says so when no deck is connected", () => {
        render(<StreamDeckSection {...SECTION} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("No Stream Deck is connected to this account.")).toBeTruthy();
    });
});

describe("DeckHostMark", () => {
    it("draws each app's own mark, the way the browser picker draws each browser's", () => {
        const { container } = render(
            <>
                <DeckHostMark host="streamdeck" />
                <DeckHostMark host="opendeck" />
                <DeckHostMark host="companion" />
            </>
        );
        expect(container.querySelector("svg path")).toBeTruthy();
        const sources = [...container.querySelectorAll("img")].map((img) =>
            img.getAttribute("src")
        );
        expect(sources).toEqual(["/logos/opendeck.webp", "/logos/bitfocus-companion.webp"]);
    });
});
