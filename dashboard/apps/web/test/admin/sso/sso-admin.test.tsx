// @vitest-environment jsdom

/**
 * The single sign-on screen: a provider's service-provider values to copy, its
 * DNS records while it waits for them, a form that refuses in the reader's
 * language as it is typed, and an edit that keeps the saved details unless the
 * administrator replaces them.
 */

import type { ReactElement } from "react";
import { MessagesWrapper, withMessages } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as draw, screen, waitFor } from "@testing-library/react";

const saveSamlProviderAction = vi.fn();
const checkSamlProviderAction = vi.fn();
const deleteSamlProviderAction = vi.fn();
vi.mock("@/app/(app)/admin/sso/actions", () => ({
    saveSamlProviderAction,
    checkSamlProviderAction,
    deleteSamlProviderAction
}));

const { SsoAdmin } = await import("@/app/(app)/admin/sso/sso-admin");

const render = (ui: ReactElement) => draw(ui, { wrapper: MessagesWrapper });

const PROVIDER = {
    providerId: "saml-abcdef123456",
    name: "Example IdP",
    domains: ["example.com"],
    allowSignUp: false,
    enforced: false,
    domainVerified: false,
    entityId: "https://idp.example.com/entity",
    ssoUrl: "https://idp.example.com/sso",
    mapping: { email: "email", name: "displayName", firstName: "givenName", lastName: "surname" },
    serviceProvider: {
        entityId:
            "https://polaris.test/api/auth/sso/saml2/sp/metadata?providerId=saml-abcdef123456",
        acsUrl: "https://polaris.test/api/auth/sso/saml2/sp/acs/saml-abcdef123456",
        metadataUrl:
            "https://polaris.test/api/auth/sso/saml2/sp/metadata?providerId=saml-abcdef123456"
    },
    records: [{ name: "_polaris-sso.example.com", value: "polaris-sso=token" }]
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("single sign-on screen", () => {
    it("says there is no provider yet and offers to add one", () => {
        render(<SsoAdmin providers={[]} />);
        expect(screen.getByText(/No identity provider yet/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Add provider" })).toBeTruthy();
    });

    it("shows the values to copy into the identity provider, and the DNS record it waits for", () => {
        render(<SsoAdmin providers={[PROVIDER]} />);
        expect(screen.getByText(PROVIDER.serviceProvider.acsUrl)).toBeTruthy();
        expect(screen.getAllByText(PROVIDER.serviceProvider.entityId).length).toBe(2);
        expect(screen.getByText("_polaris-sso.example.com")).toBeTruthy();
        expect(screen.getByText("Waiting for DNS")).toBeTruthy();
        expect(screen.getAllByRole("button", { name: /copy/i }).length).toBeGreaterThanOrEqual(5);
    });

    it("refuses a plain-http metadata address as it is typed, and keeps Save off", () => {
        render(<SsoAdmin providers={[]} />);
        fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
        const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        expect(screen.queryByText(/has to use https/)).toBeNull();
        const [name, domains, url] = screen.getAllByRole("textbox") as HTMLInputElement[];
        fireEvent.change(name!, { target: { value: "Example" } });
        fireEvent.change(domains!, { target: { value: "example.com" } });
        fireEvent.change(url!, { target: { value: "http://idp.example.com/metadata" } });
        expect(screen.getByText("The metadata address has to use https://.")).toBeTruthy();
        expect(save.disabled).toBe(true);
        fireEvent.change(url!, { target: { value: "https://idp.example.com/metadata" } });
        expect(save.disabled).toBe(false);
    });

    it("words core's refusals in Spanish for a Spanish reader", () => {
        draw(withMessages(<SsoAdmin providers={[]} />, "es-ES"));
        fireEvent.click(screen.getAllByRole("button")[0]!);
        const [, domains] = screen.getAllByRole("textbox") as HTMLInputElement[];
        fireEvent.change(domains!, { target: { value: "not a domain" } });
        expect(screen.getByText("Escribe un dominio como example.com.")).toBeTruthy();
    });

    it("edits a provider without asking for its certificate again, and only once something changed", async () => {
        saveSamlProviderAction.mockResolvedValue({
            ok: true,
            value: { ...PROVIDER, enforced: true }
        });
        render(<SsoAdmin providers={[PROVIDER]} />);
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        fireEvent.click(screen.getByRole("switch", { name: "Require single sign-on" }));
        expect(save.disabled).toBe(false);
        fireEvent.click(save);
        await waitFor(() => expect(saveSamlProviderAction).toHaveBeenCalled());
        const [input, id] = saveSamlProviderAction.mock.calls[0]!;
        expect(id).toBe(PROVIDER.providerId);
        expect(input).toMatchObject({ source: { kind: "current" }, enforced: true });
        await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
    });

    it("checks a provider and lists what passed and what did not", async () => {
        checkSamlProviderAction.mockResolvedValue({
            ok: true,
            value: {
                checks: [
                    { key: "certificate", ok: true },
                    { key: "domain", ok: false, detail: "_polaris-sso.example.com" }
                ],
                provider: PROVIDER
            }
        });
        render(<SsoAdmin providers={[PROVIDER]} />);
        fireEvent.click(screen.getByRole("button", { name: "Check now" }));
        await waitFor(() => expect(screen.getByText("Signing certificate is valid")).toBeTruthy());
        expect(screen.getByText(/DNS record found - _polaris-sso.example.com/)).toBeTruthy();
    });

    it("shows the provider as the check left it, without a reload", async () => {
        checkSamlProviderAction.mockResolvedValue({
            ok: true,
            value: {
                checks: [{ key: "domain", ok: true }],
                provider: { ...PROVIDER, domainVerified: true }
            }
        });
        render(<SsoAdmin providers={[PROVIDER]} />);
        expect(screen.getByText("Waiting for DNS")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Check now" }));
        await waitFor(() => expect(screen.getByText("Active")).toBeTruthy());
        expect(screen.queryByText("Waiting for DNS")).toBeNull();
        expect(screen.queryByText(/Add these TXT records/)).toBeNull();
    });
});
