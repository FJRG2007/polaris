// @vitest-environment jsdom

/**
 * The Public Networking panel's own pieces, mounted for real: the target-port
 * picker, what a domain's DNS and certificate read as under its row, and the TCP
 * proxy list. `public-networking.test.ts` covers the server actions behind these;
 * this is what the operator actually sees drawn from their answers - there is no
 * browser or Docker host available here to drive a real page render against.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DomainReading, ServicePorts, TcpProxyView } from "@/lib/deploy/public-networking";
import {
    DomainReadingView,
    TargetPortField,
    TcpProxyList
} from "@/app/(app)/apps/deploy/public-networking";

const tcpProxiesAction = vi.fn();
const deployApplicationAction = vi.fn();

vi.mock("@/app/(app)/apps/deploy/public-networking-actions", () => ({
    tcpProxiesAction: (applicationId: string) => tcpProxiesAction(applicationId)
}));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    deployApplicationAction: (applicationId: string) => deployApplicationAction(applicationId)
}));

afterEach(() => {
    cleanup();
    tcpProxiesAction.mockReset();
    deployApplicationAction.mockReset();
});

describe("the target port picker", () => {
    it("says it is still looking before any port has been seen", () => {
        render(<TargetPortField ports={null} value="" onChange={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Looking for the ports it listens on...")).toBeDefined();
    });

    it("shows the ports actually seen listening, with the service's own marked", () => {
        const ports: ServicePorts = { servicePort: 8080, ports: [8080, 9000], source: "runtime" };
        render(<TargetPortField ports={ports} value="8080" onChange={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        expect(
            screen.getByText("These are the ports it was seen listening on just now.")
        ).toBeDefined();
        expect(screen.getByText(":8080 (service port)")).toBeDefined();
    });
});

describe("a domain's DNS and certificate, under its row", () => {
    function reading(overrides: Partial<DomainReading> = {}): DomainReading {
        return {
            id: "dom-1",
            hostname: "shop.example.test",
            dns: null,
            cert: null,
            ...overrides
        };
    }

    it("lists the records to create while DNS does not point here yet", () => {
        render(
            <DomainReadingView
                reading={reading({
                    dns: {
                        verdict: "missing",
                        addresses: [],
                        cnames: [],
                        records: [{ type: "A", name: "shop.example.test", value: "203.0.113.7" }],
                        apex: false,
                        wildcard: false
                    }
                })}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(
            screen.getByText("Waiting for DNS. Create one of these records at your DNS provider.")
        ).toBeDefined();
        expect(screen.getByText("203.0.113.7")).toBeDefined();
    });

    it("says DNS is verified once it points here", () => {
        render(
            <DomainReadingView
                reading={reading({
                    dns: {
                        verdict: "ok",
                        addresses: ["203.0.113.7"],
                        cnames: [],
                        records: [],
                        apex: false,
                        wildcard: false
                    }
                })}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("DNS points here. Verified.")).toBeDefined();
    });

    it("names the certificate's issuer and the days left once it is live", () => {
        render(
            <DomainReadingView
                reading={reading({
                    dns: {
                        verdict: "ok",
                        addresses: ["203.0.113.7"],
                        cnames: [],
                        records: [],
                        apex: false,
                        wildcard: false
                    },
                    cert: {
                        verdict: "valid",
                        issuer: "Let's Encrypt",
                        validTo: null,
                        daysLeft: 76,
                        supplied: false
                    }
                })}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(
            screen.getByText(
                "Certificate from Let's Encrypt, valid for 76 more days. Renewed automatically 30 days before it expires."
            )
        ).toBeDefined();
    });
});

describe("the service's TCP proxies", () => {
    it("shows each proxy as address:port, pointed at the container's own port", async () => {
        const view: TcpProxyView = {
            proxies: [{ container: 25565, host: 30001 }],
            publicHost: "203.0.113.7",
            lanHost: "192.168.1.10",
            deployed: true
        };
        tcpProxiesAction.mockResolvedValue(view);
        render(
            <TcpProxyList
                applicationId="app-1"
                nonce={0}
                canEdit={true}
                onChanged={() => undefined}
            />,
            {
                wrapper: MessagesWrapper
            }
        );
        expect(await screen.findByText("203.0.113.7:30001")).toBeDefined();
        expect(screen.getByText("TCP to :25565")).toBeDefined();
        expect(screen.getByText(/forward TCP 30001 to 192\.168\.1\.10/)).toBeDefined();
    });

    it("warns a newly added proxy is not reachable until the service redeploys", async () => {
        tcpProxiesAction
            .mockResolvedValueOnce({ proxies: [], publicHost: null, lanHost: null, deployed: true })
            .mockResolvedValueOnce({
                proxies: [{ container: 25565, host: 30001 }],
                publicHost: null,
                lanHost: null,
                deployed: true
            });
        const { rerender } = render(
            <TcpProxyList
                applicationId="app-1"
                nonce={0}
                canEdit={true}
                onChanged={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        rerender(
            <TcpProxyList
                applicationId="app-1"
                nonce={1}
                canEdit={true}
                onChanged={() => undefined}
            />
        );
        expect(
            await screen.findByText("The change takes effect when the service is next started.")
        ).toBeDefined();
        expect(screen.getByText("Redeploy now")).toBeDefined();
    });
});
