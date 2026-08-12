/**
 * Which stale DNS records a background sync is allowed to repoint.
 *
 * This runs unattended, every ten minutes, against the operator's real zone, and
 * the failure it exists to prevent is a domain that dies silently when the ISP
 * rotates the address. The failure it must not cause is worse: repointing a
 * record somebody put there on purpose - an apex serving the website they already
 * had - and taking a live site down to fix a domain that was not broken.
 *
 * So the rule is narrow on purpose. A record naming the address this server used
 * to answer on is one Polaris wrote and the ISP invalidated. Anything else is
 * somebody's, and gets reported rather than taken over.
 */

import { describe, expect, it } from "vitest";
import { classifyStale } from "@/lib/domain-address-sync";

const OLD = "85.87.156.88";
const NEW = "85.87.153.18";

const zone = [
    { name: "polaris.example.com", addresses: [OLD] },
    { name: "*.polaris.example.com", addresses: [OLD] },
    { name: "*.mc.example.com", addresses: [OLD] }
];

describe("what the sync corrects", () => {
    it("repoints every name that still answers with the address we have left", () => {
        const { ours, theirs } = classifyStale(zone, NEW, OLD);
        expect(ours.map((entry) => entry.name)).toEqual([
            "polaris.example.com",
            "*.polaris.example.com",
            "*.mc.example.com"
        ]);
        expect(theirs).toEqual([]);
    });

    it("does nothing at all once they agree", () => {
        const settled = zone.map((entry) => ({ ...entry, addresses: [NEW] }));
        const { ours, theirs } = classifyStale(settled, NEW, OLD);
        expect(ours).toEqual([]);
        expect(theirs).toEqual([]);
    });

    it("counts a name that answers with the new address among others as settled", () => {
        // Cloudflare is mid-propagation, or a second record is on its way out. The
        // name reaches this server, which is what the sync is for.
        const { ours } = classifyStale([{ name: "a.example.com", addresses: [OLD, NEW] }], NEW, OLD);
        expect(ours).toEqual([]);
    });
});

describe("what the sync refuses to touch", () => {
    it("leaves a record that was never this server", () => {
        // The apex, serving the website they already had. Repointing it to fix a
        // subdomain would be an outage caused by the thing preventing outages.
        const apex = [{ name: "example.com", addresses: ["203.0.113.10"] }];
        const { ours, theirs } = classifyStale(apex, NEW, OLD);
        expect(ours).toEqual([]);
        expect(theirs.map((entry) => entry.name)).toEqual(["example.com"]);
    });

    it("takes over nothing when it has no former address to recognise ours by", () => {
        // A process that has just started cannot tell its own old address from a
        // stranger's, so it reports and lets somebody look.
        const { ours, theirs } = classifyStale(zone, NEW, null);
        expect(ours).toEqual([]);
        expect(theirs).toHaveLength(3);
    });

    it("does not treat a name that resolves to nothing as stale", () => {
        // Absent, not wrong. Creating it is the guided setup's job, done in front
        // of somebody, not a correction made behind their back.
        const { ours, theirs } = classifyStale([{ name: "new.example.com", addresses: [] }], NEW, OLD);
        expect(ours).toEqual([]);
        expect(theirs).toEqual([]);
    });

    it("stays still when the address did not actually move", () => {
        // Detection returned what we already knew, so a record disagreeing with it
        // disagrees for some other reason - and guessing is how a working zone gets
        // rewritten.
        const { ours, theirs } = classifyStale([{ name: "a.example.com", addresses: ["198.51.100.4"] }], OLD, OLD);
        expect(ours).toEqual([]);
        expect(theirs.map((entry) => entry.name)).toEqual(["a.example.com"]);
    });

    it("sorts a mixed zone into the half it may fix and the half it may not", () => {
        const mixed = [...zone, { name: "example.com", addresses: ["203.0.113.10"] }];
        const { ours, theirs } = classifyStale(mixed, NEW, OLD);
        expect(ours).toHaveLength(3);
        expect(theirs.map((entry) => entry.name)).toEqual(["example.com"]);
    });
});
