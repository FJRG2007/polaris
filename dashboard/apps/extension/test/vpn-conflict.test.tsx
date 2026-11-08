// @vitest-environment jsdom

/**
 * The VPN's card for a proxy another extension holds: who holds it, the button
 * that disables each one, and what is said where no button can help.
 */

import { ENGLISH } from "../src/lib/words";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConflictExtension, ProxyConflict } from "../src/lib/vpn";
import { ProxyConflictCard } from "../src/entrypoints/popup/vpn-conflict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const OTHER: ConflictExtension = {
    id: "other-vpn",
    name: "Other VPN",
    icon: "chrome://extension-icon/other-vpn/48/0",
    mayDisable: true
};

function card(
    conflict: ProxyConflict,
    overrides: Partial<Parameters<typeof ProxyConflictCard>[0]> = {}
) {
    const props = {
        conflict,
        connected: false,
        working: null,
        error: null,
        onFind: vi.fn(),
        onDisable: vi.fn(),
        onOpenExtensions: vi.fn(),
        t: ENGLISH,
        ...overrides
    };
    return { props, markup: renderToStaticMarkup(<ProxyConflictCard {...props} />) };
}

afterEach(() => {
    cleanup();
});

describe("the proxy conflict card", () => {
    it("names the extension, with its icon and a button that disables it", () => {
        const { markup } = card({ kind: "extensions", extensions: [OTHER] });
        expect(markup).toContain("Another extension holds the proxy");
        expect(markup).toContain("Other VPN");
        expect(markup).toContain('src="chrome://extension-icon/other-vpn/48/0"');
        expect(markup).toContain('aria-label="Disable Other VPN"');
        expect(markup).toContain(">Disable<");
    });

    it("lists several, and says so in the plural", () => {
        const { markup } = card({
            kind: "extensions",
            extensions: [OTHER, { ...OTHER, id: "second", name: "Second proxy", icon: null }]
        });
        expect(markup).toContain("Other extensions hold the proxy");
        expect(markup.match(/class="vpn-conflict-row"/g)).toHaveLength(2);
    });

    it("offers no button for one the administrator installed", () => {
        const { markup } = card({
            kind: "extensions",
            extensions: [{ ...OTHER, mayDisable: false }]
        });
        expect(markup).toContain("Installed by your administrator");
        expect(markup).not.toContain(">Disable<");
    });

    it("asks to see the extensions before it can name one", () => {
        const { markup } = card({ kind: "extensions", extensions: null });
        expect(markup).toContain("Show which one");
        expect(markup).not.toContain("vpn-conflict-row");
    });

    it("points at the browser's extensions page when nobody can be named", () => {
        const { markup } = card({ kind: "extensions", extensions: [] });
        expect(markup).toContain("Open extensions");
    });

    it("says a connection in place is not going through the VPN", () => {
        const { markup } = card({ kind: "extensions", extensions: [OTHER] }, { connected: true });
        expect(markup).toContain("does not go through the VPN");
    });

    it("names the administrator under a policy, with nothing to press", () => {
        const { markup } = card({ kind: "policy" });
        expect(markup).toContain("The proxy is set by your administrator");
        expect(markup).not.toContain("<button");
    });

    it("disables the extension pressed, once, and holds the buttons while it works", () => {
        const onDisable = vi.fn();
        const props = {
            conflict: { kind: "extensions", extensions: [OTHER] } as const,
            connected: false,
            error: null,
            onFind: vi.fn(),
            onDisable,
            onOpenExtensions: vi.fn(),
            t: ENGLISH
        };
        const { rerender } = render(<ProxyConflictCard {...props} working={null} />);
        fireEvent.click(screen.getByRole("button", { name: "Disable Other VPN" }));
        expect(onDisable).toHaveBeenCalledWith(OTHER);
        rerender(<ProxyConflictCard {...props} working="other-vpn" />);
        const button = screen.getByRole("button", { name: "Disable Other VPN" });
        expect(button.getAttribute("aria-disabled")).toBe("true");
        expect(button.textContent).toBe("Disabling");
        fireEvent.click(button);
        expect(onDisable).toHaveBeenCalledTimes(1);
    });

    it("shows why the browser refused, as an alert", () => {
        render(
            <ProxyConflictCard
                conflict={{ kind: "extensions", extensions: [OTHER] }}
                connected={false}
                working={null}
                error="The browser did not disable Other VPN. Try again."
                onFind={vi.fn()}
                onDisable={vi.fn()}
                onOpenExtensions={vi.fn()}
                t={ENGLISH}
            />
        );
        expect(screen.getByRole("alert").textContent).toContain("did not disable Other VPN");
    });
});
