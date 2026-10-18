// @vitest-environment jsdom
/**
 * One router catalogue, three screens: the Domains forward, the game-port forward
 * and the ad blocker's "point your network at it". Each renders from the same
 * guide, and the ad blocker's check reads who actually asked it today.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { MessagesWrapper, withMessages } from "../setup/i18n";
import { gameForwardRules, routerBrandsFor } from "@/lib/router-guide";

const dnsClientsAction = vi.fn(async () => ({
    clients: ["10.0.0.2", "10.0.0.7", "127.0.0.1"],
    logOff: false
}));

vi.mock("../../src/app/(app)/apps/dns-blocker/actions", () => ({ dnsClientsAction }));

const { RouterDnsGuide, RouterDnsSteps, dnsUse } = await import(
    "../../src/app/(app)/apps/dns-blocker/router-dns-guide"
);
const { RouterSteps } = await import("../../src/app/(app)/admin/domains/router-steps");

afterEach(cleanup);

describe("who is using the blocker", () => {
    it("leaves out the blocker's own machine", () => {
        expect(dnsUse(["127.0.0.1", "10.0.0.5"], "10.0.0.5")).toEqual({ kind: "none" });
    });

    it("tells a router relaying for everyone apart from devices asking directly", () => {
        expect(dnsUse(["10.0.0.1"], "10.0.0.5")).toEqual({ kind: "routerOnly", router: "10.0.0.1" });
        expect(dnsUse(["10.0.0.1", "10.0.0.9"], "10.0.0.5")).toEqual({
            kind: "devices",
            devices: ["10.0.0.1", "10.0.0.9"]
        });
    });
});

describe("the ad blocker's router steps", () => {
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
            expect(html, brand.id).toContain(brand.dns.lan.path.replace(/&/g, "&amp;").replace(/>/g, "&gt;"));
            expect(html, brand.id).toContain(brand.dns.lan.field);
            expect(html, brand.id).toContain(brand.dns.lan.source);
            const value = brand.dns.lan.value === "dhcpOption6" ? "6,10.0.0.5" : "10.0.0.5";
            expect(html, brand.id).toContain(value);
        }
    });

    it("tells UniFi to switch off its own ad blocking, which overrides any DNS server", () => {
        const html = renderToStaticMarkup(withMessages(<RouterDnsSteps brand="unifi" address="10.0.0.5" />));
        expect(html).toContain("Ad Blocking");
    });

    it("shows the devices seen today once blocking is on", async () => {
        render(<RouterDnsGuide address="10.0.0.5" blocking />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("10.0.0.7")).toBeTruthy();
        expect(screen.getByText("10.0.0.2")).toBeTruthy();
        expect(screen.queryByText("127.0.0.1")).toBeNull();
    });
});

describe("the forward guides on the Domains page", () => {
    it("starts on the brand the router named itself as", () => {
        const html = renderToStaticMarkup(withMessages(<RouterSteps server="FRITZ!OS" lanIp="10.0.0.5" />));
        expect(html).toContain("FRITZ!Box");
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
