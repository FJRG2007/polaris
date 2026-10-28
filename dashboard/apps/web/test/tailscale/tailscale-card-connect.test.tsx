// @vitest-environment jsdom

/**
 * The Tailscale card before it is connected: no key field of its own - the auth
 * key lives in Integrations, which the card links to - and a connect button that
 * asks for nothing.
 */

import type { ReactElement } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TailscaleView } from "@/lib/tailscale/tailscale-service";
import { cleanup, fireEvent, render as draw, screen, waitFor } from "@testing-library/react";

const connectTailscaleAction = vi.fn();
vi.mock("@/app/(app)/admin/domains/tailscale-actions", () => ({
    connectTailscaleAction,
    disconnectTailscaleAction: vi.fn(),
    setTailscaleTogglesAction: vi.fn(),
    setTailnetAppPublicAction: vi.fn()
}));

const { TailscaleCard, TAILSCALE_CONNECT_ID } =
    await import("@/app/(app)/admin/domains/tailscale-card");

const render = (ui: ReactElement) => draw(ui, { wrapper: MessagesWrapper });

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    connectTailscaleAction.mockReset();
    globalThis.localStorage?.clear?.();
});

const OFF: TailscaleView = {
    edition: "full",
    config: { enabled: false, serve: true, funnel: false },
    hasAuthKey: false,
    status: {
        state: "off",
        loginUrl: null,
        host: null,
        tailnet: null,
        peers: 0,
        https: null,
        funnelAllowed: null
    },
    apps: []
};

function serve(view: TailscaleView) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }))
    );
}

describe("Tailscale card, not connected", () => {
    it("asks for no key and points to Integrations for one", async () => {
        serve(OFF);
        render(<TailscaleCard />);
        const add = await screen.findByText("Use an auth key instead");
        expect(add.closest("a")?.getAttribute("href")).toBe(
            "/admin/integrations?configure=tailscale"
        );
        expect(screen.getByText(/signs in with a link you open here/)).toBeTruthy();
        expect(document.querySelector("input")).toBeNull();
    });

    it("says the saved key is what it signs in with", async () => {
        serve({ ...OFF, hasAuthKey: true });
        render(<TailscaleCard />);
        expect(await screen.findByText(/auth key saved in Integrations/)).toBeTruthy();
        expect(screen.getByText("Change it").closest("a")?.getAttribute("href")).toBe(
            "/admin/integrations?configure=tailscale"
        );
    });

    it("connects with nothing typed", async () => {
        serve(OFF);
        connectTailscaleAction.mockResolvedValue({ view: null, error: null });
        render(<TailscaleCard />);
        const button = await screen.findByRole("button", { name: "Connect with Tailscale" });
        expect(button.id).toBe(TAILSCALE_CONNECT_ID);
        expect((button as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(button);
        await waitFor(() => expect(connectTailscaleAction).toHaveBeenCalledWith({}));
    });
});
