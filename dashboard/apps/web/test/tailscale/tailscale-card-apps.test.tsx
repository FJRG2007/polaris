// @vitest-environment jsdom

/**
 * The apps list on the Tailscale card: each app with its tailnet link and its
 * settings, a public switch that says what turning it on does, and the empty state.
 */

import type { ReactElement } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TailscaleView } from "@/lib/tailscale/tailscale-service";
import { cleanup, fireEvent, render as draw, screen, waitFor } from "@testing-library/react";

const setTailnetAppPublicAction = vi.fn();
vi.mock("@/app/(app)/admin/domains/tailscale-actions", () => ({
    connectTailscaleAction: vi.fn(),
    disconnectTailscaleAction: vi.fn(),
    setTailscaleTogglesAction: vi.fn(),
    setTailnetAppPublicAction
}));

const { TailscaleCard } = await import("@/app/(app)/admin/domains/tailscale-card");

const render = (ui: ReactElement) => draw(ui, { wrapper: MessagesWrapper });

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    globalThis.localStorage?.clear?.();
});

const VIEW: TailscaleView = {
    edition: "full",
    config: { enabled: true, serve: true, funnel: false },
    hasAuthKey: false,
    status: {
        state: "connected",
        loginUrl: null,
        host: "polaris.tail1234.ts.net",
        tailnet: "example.org",
        peers: 2,
        https: true,
        funnelAllowed: true
    },
    apps: [
        {
            hostname: "shop.example.com",
            port: 10001,
            public: false,
            url: "https://polaris.tail1234.ts.net:10001",
            appName: "Shop",
            applicationId: "app-1",
            projectId: "p-1"
        }
    ]
};

function serve(view: TailscaleView) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }))
    );
}

describe("Tailscale card apps", () => {
    it("lists each app with its tailnet link and its settings", async () => {
        serve(VIEW);
        render(<TailscaleCard />);
        const link = await screen.findByText("https://polaris.tail1234.ts.net:10001");
        expect(link.closest("a")?.getAttribute("href")).toBe(
            "https://polaris.tail1234.ts.net:10001"
        );
        expect(screen.getByText("Shop").closest("a")?.getAttribute("href")).toBe(
            "/apps/deploy/p-1?service=app-1"
        );
        expect(screen.getByText("shop.example.com")).toBeTruthy();
        expect(screen.getByText(/moves the app to port 8443 or 10000/)).toBeTruthy();
    });

    it("turns an app public through the action", async () => {
        serve(VIEW);
        setTailnetAppPublicAction.mockResolvedValue({
            view: {
                ...VIEW,
                apps: [
                    {
                        ...VIEW.apps[0]!,
                        port: 8443,
                        public: true,
                        url: "https://polaris.tail1234.ts.net:8443"
                    }
                ]
            },
            error: null
        });
        render(<TailscaleCard />);
        const toggle = await screen.findByRole("switch", { name: "Public: Shop" });
        fireEvent.click(toggle);
        await waitFor(() =>
            expect(setTailnetAppPublicAction).toHaveBeenCalledWith({
                hostname: "shop.example.com",
                public: true
            })
        );
        expect(await screen.findByText("https://polaris.tail1234.ts.net:8443")).toBeTruthy();
        expect(screen.getByText(/This app is public/)).toBeTruthy();
    });

    it("says how an app gets an address when none has one", async () => {
        serve({ ...VIEW, apps: [] });
        render(<TailscaleCard />);
        expect(await screen.findByText(/No app is on your tailnet yet/)).toBeTruthy();
    });
});
