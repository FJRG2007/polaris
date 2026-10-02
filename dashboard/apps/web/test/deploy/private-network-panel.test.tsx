// @vitest-environment jsdom

/**
 * The Private networking panel end to end: it loads a service's view, offers
 * the Railway-style address and short name, checks a new name's availability
 * live as it is typed, saves an extra alias with optimistic rollback, and
 * opens a cross-project link to a candidate from another project - the whole
 * workflow a person uses from the deploy canvas, not just its pure helpers.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { PrivateNetworkView } from "@/lib/deploy/private-names";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PrivateNetworkPanel } from "@/app/(app)/apps/deploy/private-network-panel";

// What jsdom does not implement and Radix's Select calls on the way open.
beforeAll(() => {
    Object.assign(Element.prototype, {
        hasPointerCapture: () => false,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        scrollIntoView: () => undefined
    });
});

const privateNetworkAction = vi.fn();
const checkPrivateNameAction = vi.fn();
const renamePrivateNameAction = vi.fn();
const setPrivateAliasesAction = vi.fn();
const crossLinkCandidatesAction = vi.fn();
const addCrossLinkAction = vi.fn();
const removeCrossLinkAction = vi.fn();

vi.mock("@/app/(app)/apps/deploy/private-network-actions", () => ({
    privateNetworkAction: (...args: unknown[]) => privateNetworkAction(...args),
    checkPrivateNameAction: (...args: unknown[]) => checkPrivateNameAction(...args),
    renamePrivateNameAction: (...args: unknown[]) => renamePrivateNameAction(...args),
    setPrivateAliasesAction: (...args: unknown[]) => setPrivateAliasesAction(...args),
    crossLinkCandidatesAction: (...args: unknown[]) => crossLinkCandidatesAction(...args),
    addCrossLinkAction: (...args: unknown[]) => addCrossLinkAction(...args),
    removeCrossLinkAction: (...args: unknown[]) => removeCrossLinkAction(...args)
}));

const BASE_VIEW: PrivateNetworkView = {
    kind: "application",
    projectId: "project-1",
    name: "api",
    domain: "api.polaris.internal",
    aliases: ["dymoapi"],
    former: [{ name: "backend", until: "2026-10-09T00:00:00.000Z" }],
    family: "dual",
    status: "ready",
    takenBy: null,
    serverName: "edge-1",
    port: 3000,
    portless: true,
    sharedEnvironment: false,
    linksMode: false,
    reach: [{ id: "svc-worker", kind: "application", name: "worker", serverName: "edge-1" }],
    unreachable: [{ id: "svc-cache", kind: "database", name: "cache", serverName: "edge-2" }],
    crossLinks: [
        {
            id: "link-1",
            direction: "in",
            serviceName: "billing",
            projectName: "Billing",
            domain: "api.acme.polaris.internal",
            sameServer: true
        }
    ],
    crossLinksOffered: true
};

async function mountReady(overrides: Partial<PrivateNetworkView> = {}, id = "service-1") {
    privateNetworkAction.mockResolvedValue({ view: { ...BASE_VIEW, ...overrides }, canEdit: true });
    render(<PrivateNetworkPanel kind="application" id={id} />, { wrapper: MessagesWrapper });
    await screen.findByText("api.polaris.internal");
}

describe("the private networking panel", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("shows the address, short name, port-less reach and who can call it", async () => {
        await mountReady();

        expect(screen.getByText("api.polaris.internal")).toBeTruthy();
        expect(screen.getByText("Ready to talk privately")).toBeTruthy();
        expect(screen.getByText("IPv4 & IPv6")).toBeTruthy();
        expect(screen.getByText(/Also reachable as/).textContent).toContain("api");
        expect(screen.getByText(/reaches port 3000/)).toBeTruthy();
        expect(screen.getByText(/Still answers to/).textContent).toContain("backend");
        expect(screen.getByText("worker")).toBeTruthy();
        expect(screen.getByText(/Unreachable from edge-2/)).toBeTruthy();
        expect(screen.getByText(/cache cannot call it by name/)).toBeTruthy();
        expect(screen.getByText(/billing/i)).toBeTruthy();
    });

    it("checks a new name live as it is typed and blocks saving an unavailable one", async () => {
        const user = userEvent.setup();
        await mountReady();

        await user.click(screen.getByRole("button", { name: "Edit" }));
        const input = screen.getByLabelText(/Private name/);
        await user.clear(input);
        await user.type(input, "worker");

        checkPrivateNameAction.mockResolvedValueOnce({
            name: "worker",
            available: false,
            message: "worker already answers to that name."
        });
        await waitFor(() =>
            expect(checkPrivateNameAction).toHaveBeenCalledWith(
                "application",
                "service-1",
                "worker"
            )
        );
        expect(await screen.findByText("worker already answers to that name.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Update" }).getAttribute("aria-disabled")).toBe(
            "true"
        );

        await user.clear(input);
        await user.type(input, "api-v2");
        checkPrivateNameAction.mockResolvedValueOnce({ name: "api-v2", available: true });
        await waitFor(() =>
            expect(checkPrivateNameAction).toHaveBeenCalledWith(
                "application",
                "service-1",
                "api-v2"
            )
        );
        expect(await screen.findByText("Endpoint name available!")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Update" }).getAttribute("aria-disabled")).toBe(
            "false"
        );

        renamePrivateNameAction.mockResolvedValueOnce({ applied: "next" });
        await user.click(screen.getByRole("button", { name: "Update" }));
        await waitFor(() =>
            expect(renamePrivateNameAction).toHaveBeenCalledWith(
                "application",
                "service-1",
                "api-v2"
            )
        );
        expect(
            await screen.findByText(
                "Renamed. It takes the new name on its next deploy, so its connections are not cut now."
            )
        ).toBeTruthy();
    });

    it("adds an alias optimistically and rolls it back when the server refuses", async () => {
        const user = userEvent.setup();
        await mountReady();

        const aliasInput = screen.getByPlaceholderText("e.g. dymoapi");
        await user.type(aliasInput, "legacy-api");

        // The server is not asked to resolve yet, so the optimistic add and its
        // rollback are two separate, observable moments rather than one blur.
        let resolveSave: (value: { error?: string }) => void = () => undefined;
        setPrivateAliasesAction.mockImplementationOnce(
            () => new Promise((resolve) => (resolveSave = resolve))
        );
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(screen.getByText("legacy-api")).toBeTruthy();

        await act(async () => resolveSave({ error: "A service can have up to 5 other names." }));
        expect(await screen.findByText("A service can have up to 5 other names.")).toBeTruthy();
        expect(screen.queryByText("legacy-api")).toBeNull();
    });

    it("opens the cross-project picker and allows a candidate from another project", async () => {
        const user = userEvent.setup();
        await mountReady();

        crossLinkCandidatesAction.mockResolvedValueOnce({
            candidates: [
                {
                    id: "svc-2",
                    name: "checkout",
                    projectName: "Storefront",
                    environmentName: "production"
                }
            ]
        });
        await user.click(screen.getByRole("button", { name: "Allow a service" }));
        await waitFor(() =>
            expect(crossLinkCandidatesAction).toHaveBeenCalledWith("application", "service-1")
        );

        await user.click(
            await screen.findByRole("combobox", { name: "Service of another project" })
        );
        const option = await screen.findByRole("option", { name: /checkout/ });
        addCrossLinkAction.mockResolvedValueOnce({});
        await user.click(option);

        await user.click(screen.getByRole("button", { name: "Allow" }));
        await waitFor(() =>
            expect(addCrossLinkAction).toHaveBeenCalledWith("application", "service-1", "svc-2")
        );
    });

    it("asks before closing a link, and closes it only once agreed to", async () => {
        const user = userEvent.setup();
        await mountReady();

        await user.click(screen.getByRole("button", { name: "Close the link with billing" }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog.textContent).toContain("loses its connections to this service now");
        expect(removeCrossLinkAction).not.toHaveBeenCalled();

        removeCrossLinkAction.mockResolvedValueOnce({});
        await user.click(screen.getByRole("button", { name: "Close link" }));
        await waitFor(() =>
            expect(removeCrossLinkAction).toHaveBeenCalledWith("application", "service-1", "link-1")
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("offers no new link on a server that does not carry them", async () => {
        await mountReady({ crossLinksOffered: false }, "service-swarm");
        expect(screen.queryByRole("button", { name: "Allow a service" })).toBeNull();
        expect(screen.getByText(/not available on Swarm servers/)).toBeTruthy();
    });
});
