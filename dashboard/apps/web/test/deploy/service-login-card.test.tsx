// @vitest-environment jsdom
/**
 * The "Require Polaris login" card in a service's Security & edge settings.
 *
 * A switch the reader cannot use says why under it rather than answering a click with
 * a refusal; a service with no address cannot be put behind a login yet; and a refused
 * save puts the switch back where the server has it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const APP = "00000000-0000-7000-8000-0000000000a1";
const LOGIN = {
    requireLogin: true,
    requiredAbove: false,
    loginAllowPrincipals: [],
    loginDenyPrincipals: [],
    hostnames: ["app.example.test"],
    hostnameCount: 1
};

let answer: Record<string, unknown> = {};
const setServiceLoginAction = vi.fn(async (_input: unknown) => ({}) as { error?: string });

vi.mock("../../src/app/(app)/apps/firewall/actions", () => ({
    getServiceLoginAction: async () => answer,
    setServiceLoginAction: (input: unknown) => setServiceLoginAction(input),
    serviceLoginAccessAction: async () => ({}),
    findWafPeopleAction: async () => ({ results: [] }),
    listWafPrincipalsAction: async () => ({ principals: [] })
}));

const { ServiceLoginCard, serviceLoginRuleHref } = await import(
    "../../src/app/(app)/apps/deploy/service-login"
);

afterEach(() => {
    cleanup();
    setServiceLoginAction.mockClear();
});

let mounted = 0;
async function card(): Promise<HTMLElement> {
    // A fresh service id per render, so the card's last-read cache never carries over.
    const id = `${APP.slice(0, -2)}${String(mounted++).padStart(2, "0")}`;
    render(
        <MessagesWrapper>
            <ServiceLoginCard applicationId={id} />
        </MessagesWrapper>
    );
    return screen.findByRole("switch");
}

describe("the service login card", () => {
    it("is on, names the address it covers and links to the firewall rule", async () => {
        answer = { login: LOGIN };
        const toggle = await card();
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByText(/app\.example\.test/)).toBeTruthy();
        const link = screen.getByRole("link", { name: /Open in firewall/ });
        expect(link.getAttribute("href")).toContain("scope=application");
        expect(link.getAttribute("href")).toContain("rule=login");
    });

    it("tells a reader who does not own the project why, and offers no link", async () => {
        answer = { refusal: "owner" };
        const toggle = await card();
        expect(toggle.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/Only the project's owner/)).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("cannot be switched on before the service has an address", async () => {
        answer = { login: { ...LOGIN, requireLogin: false, hostnames: [], hostnameCount: 0 } };
        const toggle = await card();
        expect(toggle.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/no address yet/)).toBeTruthy();
    });

    it("writes the switch and puts it back when the server refuses", async () => {
        answer = { login: LOGIN };
        setServiceLoginAction.mockImplementationOnce(async () => ({ error: "refused" }));
        const toggle = await card();
        fireEvent.click(toggle);
        expect(setServiceLoginAction).toHaveBeenCalledWith(
            expect.objectContaining({ requireLogin: false })
        );
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    });

    it("links at the firewall's Service scope on its login rule", () => {
        expect(serviceLoginRuleHref(APP)).toBe(
            `/apps/firewall?scope=application&id=${APP}&rule=login`
        );
    });
});
