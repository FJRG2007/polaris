/**
 * Which hostname a service is presented as. The rule being protected: a deploy
 * must never change it. A quick tunnel gets a brand-new random hostname every time
 * it starts - and it starts on every deploy - so it used to outrank the free
 * subdomain and quietly move the service's address.
 */

import { describe, expect, it } from "vitest";
import { primaryDomain, type AppDomain } from "../../src/app/(app)/apps/deploy/domain-rank";

function domain(partial: Partial<AppDomain> & { hostname: string; kind: string }): AppDomain {
    return { id: partial.hostname, enabled: true, ...partial };
}

const FREE = domain({ hostname: "invoices-a1b2c3-51-15-20-30.sslip.io", kind: "auto" });

describe("primaryDomain", () => {
    it("keeps the free subdomain over a quick tunnel that is renamed on every deploy", () => {
        const first = domain({ hostname: "ronald-kent-leg-plate.trycloudflare.com", kind: "tunnel-temp" });
        const second = domain({ hostname: "olive-badge-rapid-tin.trycloudflare.com", kind: "tunnel-temp" });
        expect(primaryDomain([FREE, first])).toBe(FREE);
        expect(primaryDomain([FREE, second])).toBe(FREE);
    });

    it("still offers a throwaway tunnel over a name that only resolves on the LAN", () => {
        const lan = domain({ hostname: "invoices-a1b2c3-192-168-1-20.sslip.io", kind: "lan" });
        const tunnel = domain({ hostname: "ronald-kent-leg-plate.trycloudflare.com", kind: "tunnel-temp" });
        expect(primaryDomain([lan, tunnel])).toBe(tunnel);
    });

    it("lets a named tunnel and a custom domain take over, since neither is renamed", () => {
        const named = domain({ hostname: "app.example.com", kind: "tunnel" });
        const custom = domain({ hostname: "invoices.example.com", kind: "custom" });
        expect(primaryDomain([FREE, named])).toBe(named);
        expect(primaryDomain([FREE, named, custom])).toBe(custom);
    });

    it("never presents a service as one of its releases", () => {
        const release = domain({ hostname: "invoices-a1b2c3-9f8e7d6-51-15-20-30.sslip.io", kind: "release" });
        expect(primaryDomain([release])).toBeNull();
        expect(primaryDomain([FREE, release])).toBe(FREE);
    });

    it("ignores a disabled domain", () => {
        expect(primaryDomain([{ ...FREE, enabled: false }])).toBeNull();
    });
});
