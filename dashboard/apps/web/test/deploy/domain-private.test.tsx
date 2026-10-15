// @vitest-environment jsdom

/**
 * The Private switch on an address: somebody who may manage the project's domains can
 * turn it on or off and save it; anybody else sees the same dialog with the switch
 * held off and the reason beside it, and no way to save.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateAccess } from "@/lib/deploy/private-domain";
import { DomainPrivateButton } from "@/app/(app)/apps/deploy/domain-private";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const DOMAIN = "0192f1e2-7b5c-7d3e-8f00-00000000000d";

const actions = vi.hoisted(() => ({
    setDomainPrivateAction: vi.fn(async (_input: unknown) => ({}) as { error?: string })
}));

vi.mock("@/app/(app)/apps/deploy/actions", () => actions);
// The principal picker reads the directory; what matters here is the switch around it.
vi.mock("@/app/(app)/apps/firewall/login-principals", () => ({ LoginPrincipals: () => null }));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function open(options: { canManage: boolean; access?: PrivateAccess | null }) {
    const onChanged = vi.fn();
    render(
        <DomainPrivateButton
            domainId={DOMAIN}
            applicationId="0190f3a2-7c41-7000-8000-000000000001"
            hostname="intranet.example.com"
            access={options.access ?? null}
            canManage={options.canManage}
            onChanged={onChanged}
        />,
        { wrapper: MessagesWrapper }
    );
    const label = options.access ? "Private: only people you allow" : "Public: anyone can open it";
    fireEvent.click(screen.getByRole("button", { name: label }));
    return { onChanged };
}

describe("the Private switch on an address", () => {
    it("lets a domain manager turn it on for the project's members and save", async () => {
        const { onChanged } = open({ canManage: true });
        const toggle = screen.getByRole("switch", { name: "Only allowed people" });
        expect(toggle.hasAttribute("disabled")).toBe(false);
        expect(screen.queryByText("You cannot change this project's domains.")).toBeNull();
        const save = screen.getByRole("button", { name: "Save" });
        // Nothing changed yet, so nothing to save.
        expect(save.hasAttribute("disabled")).toBe(true);

        fireEvent.click(toggle);
        expect(screen.getByRole("checkbox", { name: /Members of this project/ })).toBeTruthy();
        expect(save.hasAttribute("disabled")).toBe(false);
        fireEvent.click(save);
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
        expect(actions.setDomainPrivateAction).toHaveBeenCalledWith({
            domainId: DOMAIN,
            access: { members: true, allow: [], deny: [] }
        });
    });

    it("holds the switch off, says why, and offers no save to somebody who cannot manage domains", () => {
        open({ canManage: false, access: { members: true, allow: [], deny: [] } });
        const toggle = screen.getByRole("switch", { name: "Only allowed people" });
        expect(toggle.hasAttribute("disabled")).toBe(true);
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByText("You cannot change this project's domains.")).toBeTruthy();
        expect(
            screen
                .getByRole("checkbox", { name: /Members of this project/ })
                .hasAttribute("disabled")
        ).toBe(true);
        expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
        expect(actions.setDomainPrivateAction).not.toHaveBeenCalled();
    });

    it("will not save an address nobody could open", () => {
        open({ canManage: true });
        fireEvent.click(screen.getByRole("switch", { name: "Only allowed people" }));
        fireEvent.click(screen.getByRole("checkbox", { name: /Members of this project/ }));
        expect(screen.getByText("Choose who may open this address.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    });

    it("shows what the server answered when it refuses", async () => {
        actions.setDomainPrivateAction.mockResolvedValueOnce({ error: "Domain not found" });
        const { onChanged } = open({
            canManage: true,
            access: { members: true, allow: [], deny: [] }
        });
        fireEvent.click(screen.getByRole("switch", { name: "Only allowed people" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Domain not found")).toBeTruthy();
        expect(actions.setDomainPrivateAction).toHaveBeenCalledWith({
            domainId: DOMAIN,
            access: null
        });
        expect(onChanged).not.toHaveBeenCalled();
    });
});
