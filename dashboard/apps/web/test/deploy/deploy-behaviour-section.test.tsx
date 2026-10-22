// @vitest-environment jsdom

/**
 * The per-service Deploys section: what an operator reading the service page
 * actually sees for the zero-downtime change-over and for a service that still
 * restarts, in the exact words `deploy-behaviour-section.tsx` draws them with.
 *
 * Mounts the real component against a stand-in for its server action, the same
 * way the other screen tests in this suite stand in for a server action rather
 * than a browser - there is no browser or Docker host available here to drive a
 * real page render against.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DeployBehaviourView } from "@/lib/deploy/deploy-behaviour";
import { DeployBehaviourSection } from "@/app/(app)/apps/deploy/deploy-behaviour-section";

const behaviourAction = vi.fn();
const blockAction = vi.fn();

vi.mock("@/app/(app)/apps/deploy/deploy-behaviour-actions", () => ({
    deployBehaviourAction: (applicationId: string) => behaviourAction(applicationId),
    setOverlapVolumesAction: vi.fn(async () => ({})),
    setBlockVulnerableDeploysAction: (applicationId: string, value: boolean) =>
        blockAction(applicationId, value),
    setExternalNetworksAction: vi.fn(async () => ({}))
}));

afterEach(() => {
    cleanup();
    behaviourAction.mockReset();
    blockAction.mockReset();
});

function view(overrides: Partial<DeployBehaviourView> = {}): DeployBehaviourView {
    return {
        strategy: { mode: "overlap" },
        hasVolumes: false,
        overlapChoice: false,
        overlapVolumes: false,
        externalNetworks: [],
        defaultAlias: "shop",
        blockVulnerableDeploys: false,
        ...overrides
    };
}

describe("the Deploys section of a service page", () => {
    it("tells the operator a deploy has no gap, in the overlap release's own words", async () => {
        behaviourAction.mockResolvedValue({ view: view() });
        render(<DeployBehaviourSection applicationId="app-1" canConfigure={true} />, {
            wrapper: MessagesWrapper
        });

        expect(await screen.findByText("Zero downtime")).toBeDefined();
        expect(
            screen.getByText(
                /The new version starts beside the running one\. The edge moves to it once it answers on its port/
            )
        ).toBeDefined();
    });

    it("names every reason a deploy restarts this service instead", async () => {
        behaviourAction.mockResolvedValue({
            view: view({
                strategy: {
                    mode: "restart",
                    reasons: [
                        { code: "hostPort", port: 25565, protocol: "udp" },
                        { code: "volumes", names: ["uploads"] }
                    ]
                }
            })
        });
        render(<DeployBehaviourSection applicationId="app-1" canConfigure={true} />, {
            wrapper: MessagesWrapper
        });

        expect(await screen.findByText("Restarts on deploy")).toBeDefined();
        expect(screen.getByText(/It binds port 25565\/UDP on the server/)).toBeDefined();
        expect(screen.getByText(/It keeps data on uploads/)).toBeDefined();
    });

    it("shows the operator's own networks with the name a container there calls this service by", async () => {
        behaviourAction.mockResolvedValue({
            view: view({
                externalNetworks: [
                    { name: "app_network", aliases: ["payments-api", "paymentsapi"] }
                ]
            })
        });
        render(<DeployBehaviourSection applicationId="app-1" canConfigure={true} />, {
            wrapper: MessagesWrapper
        });

        expect(await screen.findByDisplayValue("app_network")).toBeDefined();
        expect(screen.getByDisplayValue("payments-api, paymentsapi")).toBeDefined();
    });

    it("reports the load failure in words instead of leaving the section blank", async () => {
        behaviourAction.mockResolvedValue({ error: "Could not read how this service deploys" });
        render(<DeployBehaviourSection applicationId="app-1" canConfigure={true} />, {
            wrapper: MessagesWrapper
        });

        expect(await screen.findByText("Could not read how this service deploys")).toBeDefined();
    });

    it("turns blocking vulnerable releases on at once, and puts it back when the server refuses", async () => {
        behaviourAction.mockResolvedValue({ view: view() });
        blockAction.mockResolvedValue({ error: "Could not save how this service deploys" });
        render(<DeployBehaviourSection applicationId="app-1" canConfigure={true} />, {
            wrapper: MessagesWrapper
        });

        const toggle = await screen.findByRole("switch", { name: "Block vulnerable releases" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        fireEvent.click(toggle);
        expect(blockAction).toHaveBeenCalledWith("app-1", true);
        expect(await screen.findByText("Could not save how this service deploys")).toBeDefined();
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    });

    it("keeps the setting on once the server takes it", async () => {
        behaviourAction.mockResolvedValue({ view: view() });
        blockAction.mockResolvedValue({});
        render(<DeployBehaviourSection applicationId="app-1" canConfigure={true} />, {
            wrapper: MessagesWrapper
        });

        const toggle = await screen.findByRole("switch", { name: "Block vulnerable releases" });
        fireEvent.click(toggle);
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    });

    it("shows the setting to a reader who may not change it, switched off for them", async () => {
        behaviourAction.mockResolvedValue({ view: view({ blockVulnerableDeploys: true }) });
        render(<DeployBehaviourSection applicationId="app-1" canConfigure={false} />, {
            wrapper: MessagesWrapper
        });

        const toggle = await screen.findByRole("switch", { name: "Block vulnerable releases" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect((toggle as HTMLButtonElement).disabled).toBe(true);
    });
});
