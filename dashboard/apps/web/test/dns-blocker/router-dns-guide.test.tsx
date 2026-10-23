// @vitest-environment jsdom
/**
 * One router catalogue, three screens: the Domains forward, the game-port forward
 * and the network filter's "point your network at it". Each renders from the same
 * guide, and the network filter's check reads who actually asked it in the last 24 hours.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { gameForwardRules, routerBrandsFor } from "@/lib/router-guide";

const dnsClientsAction = vi.fn(async (): Promise<{ clients: string[]; logOff: boolean }> => ({
    clients: ["10.0.0.2", "10.0.0.7", "127.0.0.1"],
    logOff: false
}));

vi.mock("../../src/app/(app)/apps/network-filter/actions", () => ({ dnsClientsAction }));

const { RouterDnsGuide, RouterDnsSteps, dnsUse } =
    await import("../../src/app/(app)/apps/network-filter/router-dns-guide");
const { RouterSteps } = await import("../../src/app/(app)/admin/domains/router-steps");

afterEach(cleanup);

const brands = routerBrandsFor("dns").map((entry) => ({ value: entry.id, label: entry.label }));

describe("who is using the blocker", () => {
    it("leaves out the blocker's own machine", () => {
        expect(dnsUse(["127.0.0.1", "10.0.0.5"], "10.0.0.5")).toEqual({ kind: "none" });
    });

    it("tells a router relaying for everyone apart from devices asking directly", () => {
        expect(dnsUse(["10.0.0.1"], "10.0.0.5")).toEqual({
            kind: "routerOnly",
            router: "10.0.0.1"
        });
        expect(dnsUse(["10.0.0.1", "10.0.0.9"], "10.0.0.5")).toEqual({
            kind: "devices",
            devices: ["10.0.0.1", "10.0.0.9"]
        });
    });
});

describe("the network filter's router steps", () => {
    it("names each documented brand's own menu, field and source", () => {
        for (const brand of routerBrandsFor("dns")) {
            const html = renderToStaticMarkup(
                withMessages(<RouterDnsSteps brand={brand.id} address="10.0.0.5" />)
            );
            if (!brand.dns) {
                // The generic entry still says which address to hand out.
                expect(html, brand.id).toContain("10.0.0.5");
                continue;
            }
            expect(html, brand.id).toContain(
                brand.dns.lan.path.replace(/&/g, "&amp;").replace(/>/g, "&gt;")
            );
            expect(html, brand.id).toContain(brand.dns.lan.field);
            expect(html, brand.id).toContain(brand.dns.lan.source);
            const value = brand.dns.lan.value === "dhcpOption6" ? "6,10.0.0.5" : "10.0.0.5";
            expect(html, brand.id).toContain(value);
        }
    });

    it("offers ZTE in the picker and walks it through its DHCP Server tab", () => {
        expect(brands.map((brand) => brand.value)).toContain("zte");
        const html = renderToStaticMarkup(
            withMessages(<RouterDnsSteps brand="zte" address="10.0.0.5" />)
        );
        expect(html).toContain("Local Network &gt; LAN &gt; DHCP Server, with ISP DNS set to Off");
        expect(html).toContain('<b class="font-medium text-foreground">Primary DNS</b>');
        expect(html).toContain('<b class="font-medium text-foreground">Apply</b>');
        expect(html).toContain("over IPv6");
    });

    it("tells UniFi to switch off its own ad blocking, which overrides any DNS server", () => {
        const html = renderToStaticMarkup(
            withMessages(<RouterDnsSteps brand="unifi" address="10.0.0.5" />)
        );
        expect(html).toContain("Ad Blocking");
    });

    it("shows the devices seen in the last 24 hours once blocking is on", async () => {
        render(<RouterDnsGuide address="10.0.0.5" blocking brands={brands} />, {
            wrapper: MessagesWrapper
        });
        expect(await screen.findByText("10.0.0.7")).toBeTruthy();
        expect(screen.getByText("10.0.0.2")).toBeTruthy();
        expect(screen.queryByText("127.0.0.1")).toBeNull();
    });

    it("says the check failed and lets it run again when the action cannot be reached", async () => {
        dnsClientsAction.mockRejectedValueOnce(new Error("network"));
        render(<RouterDnsGuide address="10.0.0.5" blocking brands={brands} />, {
            wrapper: MessagesWrapper
        });
        expect(await screen.findByRole("alert")).toBeTruthy();
        const again = screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement;
        expect(again.disabled).toBe(false);
    });
});

describe("the forward guides on the Domains page", () => {
    it("starts on the brand the router named itself as", () => {
        const html = renderToStaticMarkup(
            withMessages(<RouterSteps server="FRITZ!OS" lanIp="10.0.0.5" />)
        );
        expect(html).toContain("FRITZ!Box");
    });

    it("walks a provider box through its own Spanish menus once the steps are open", async () => {
        render(<RouterSteps server="Livebox" lanIp="10.0.0.5" />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: /exactly what to do/i }));
        expect(
            await screen.findByText("Configuración avanzada > Configuración de red > NAT/PAT")
        ).toBeTruthy();
        expect(document.body.textContent).toContain("http://192.168.1.1");
    });

    it("sends an app-only mesh system to its app, with no admin page to open or turn off", async () => {
        Element.prototype.scrollIntoView ??= vi.fn();
        render(<RouterSteps server={null} lanIp="10.0.0.5" />, { wrapper: MessagesWrapper });
        const picker = screen.getByRole("combobox");
        fireEvent.click(picker);
        fireEvent.click(await screen.findByRole("option", { name: "eero" }));
        fireEvent.click(screen.getByRole("button", { name: /exactly what to do/i }));
        expect(await screen.findByText(/Open the eero app/)).toBeTruthy();
        expect(screen.queryByRole("link", { name: /Open the router/ })).toBeNull();
        expect(document.body.textContent).not.toContain("http://10.0.0.1");
        expect(document.body.textContent).not.toContain("remote-management");
    });

    it("puts D-Link's port in the box for the rule's transport and no Protocol row", async () => {
        render(<RouterSteps server="D-Link" lanIp="10.0.0.5" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: /exactly what to do/i }));
        const tcp = (await screen.findByText("TCP Port")).closest("tr")!;
        expect(tcp.textContent).toContain("80");
        expect(tcp.textContent).toContain("443");
        expect(screen.getByText("UDP Port").closest("tr")!.textContent).toBe("UDP Port");
        expect(screen.queryByText("Protocol")).toBeNull();
    });

    it("offers the app-only mesh systems to the network filter with their app's path", () => {
        expect(brands.map((brand) => brand.value)).toEqual(
            expect.arrayContaining(["googlewifi", "eero"])
        );
        const html = renderToStaticMarkup(
            withMessages(<RouterDnsSteps brand="eero" address="10.0.0.5" />)
        );
        expect(html).toContain("eero app &gt; Settings &gt; Advanced networking &gt; DNS");
        expect(html).toContain("eero Plus");
    });

    it("renders the game-port rules from the same catalogue", () => {
        const rules = gameForwardRules([
            { name: "Survival", ports: [{ port: 25565, protocol: "tcp" }] }
        ]);
        const html = renderToStaticMarkup(
            withMessages(<RouterSteps server={null} lanIp="10.0.0.5" rules={rules} />)
        );
        expect(html).toContain("Another brand");
    });
});
