import { execFileSync } from "node:child_process";
import * as wg from "@/lib/vpn/wireguard";
import { describe, expect, it } from "vitest";
import {
    PROXY_PROOF_HOST,
    edgeIsReady,
    parseProxyUsage,
    renderProxyEdge,
    renderProxyScript
} from "@/lib/vpn/browser-proxy";

const access = {
    nodes: [],
    deviceLimit: 5,
    dataLimitGb: null,
    expiresAt: null,
    suspended: false,
    usedBytes: 0n
};
const NOW = new Date("2026-11-02T00:00:00Z");

describe("node addresses", () => {
    it("gives every node its own range", () => {
        expect(wg.nodeSubnet(0).cidr).not.toBe(wg.nodeSubnet(1).cidr);
    });

    it("reuses the lowest free address and stops when full", () => {
        const first = wg.freeHost([]);
        expect(first).not.toBeNull();
        expect(wg.freeHost([first as number])).not.toBe(first);
        const all = Array.from({ length: wg.MAX_DEVICES_ON_NODE + 2 }, (_, index) => index);
        expect(wg.freeHost(all)).toBeNull();
    });
});

describe("standing", () => {
    it("reads active with nothing against it", () => {
        expect(wg.accessStanding(access, NOW)).toBe("active");
    });

    it("puts suspension first, then expiry, then traffic", () => {
        const expired = { ...access, expiresAt: new Date("2026-01-01T00:00:00Z") };
        expect(wg.accessStanding({ ...expired, suspended: true }, NOW)).toBe("suspended");
        expect(wg.accessStanding(expired, NOW)).toBe("expired");
        const spent = { ...access, dataLimitGb: 1, usedBytes: 2n * 1024n ** 3n };
        expect(wg.accessStanding(spent, NOW)).toBe("overLimit");
    });

    it("treats an empty node list as every node", () => {
        expect(wg.mayUseNode(access, "a")).toBe(true);
        expect(wg.mayUseNode({ ...access, nodes: ["b"] }, "a")).toBe(false);
    });
});

describe("node rules", () => {
    const direct = wg.renderNodeRules({ index: 0, port: 51820, exit: "direct" });
    const tor = wg.renderNodeRules({ index: 0, port: 51820, exit: "tor" });

    it("keeps devices apart and away from private networks", () => {
        expect(direct).toContain("192.168.0.0/16");
        expect(direct).toContain("masquerade");
    });

    it("lets nothing leave a Tor node except through Tor", () => {
        expect(tor).not.toContain("masquerade");
        expect(tor).toContain("redirect to");
    });
});

describe("counters", () => {
    it("adds growth, and a restarted interface counts from zero", () => {
        expect(wg.counterGrowth(150n, 100n)).toBe(50n);
        expect(wg.counterGrowth(20n, 100n)).toBe(20n);
    });
});

describe("endpoints", () => {
    it("tells a public address from a private one", () => {
        expect(wg.isPublicEndpoint("192.168.1.10")).toBe(false);
        expect(wg.isPublicEndpoint("10.0.0.1")).toBe(false);
        expect(wg.isPublicEndpoint("vpn.example.test")).toBe(true);
    });
});

describe("the scripts sent to a node", () => {
    const peer = { publicKey: `${"A".repeat(43)}=`, host: 2 };
    const direct = { index: 0, port: 51820, exit: "direct" as const };

    it.each([
        ["direct", wg.renderNodeApply(direct, [peer])],
        ["tor", wg.renderNodeApply({ ...direct, exit: "tor" }, [peer])],
        ["no devices", wg.renderNodeApply(direct, [])],
        ["peer sync", wg.renderPeerSync(direct, [peer])]
    ])("parse as shell: %s", (_name, script) => {
        expect(() => execFileSync("sh", ["-n"], { input: script, stdio: "pipe" })).not.toThrow();
    });

    it("keep the peers where a confined wg can read them", () => {
        const peers = wg.renderPeers(direct, [peer]);
        expect(peers).toContain("wg syncconf polaris-vpn /etc/wireguard/polaris-vpn.conf");
        expect(wg.NODE_REMOVE).toContain("/etc/wireguard/polaris-vpn.conf");
    });

    it("let the edge through a firewall that denies by default", () => {
        const rule = "ufw allow from 172.16.0.0/12 to any port 51821 proto tcp";
        expect(wg.renderNodeApply(direct, [])).toContain(rule);
        expect(wg.NODE_REMOVE).toContain("ufw delete allow from 172.16.0.0/12");
    });

    it("do not let the package manager choose a kernel", () => {
        expect(wg.renderNodeApply(direct, [])).toContain("--no-install-recommends");
    });
});

describe("the browser proxy", () => {
    it("holds its route to the one protocol it speaks", () => {
        const edge = renderProxyEdge("vpn.example.test");
        expect(edge).toContain("options: polaris-vpn-proxy");
        expect(edge).toContain("alpnProtocols: [http/1.1]");
    });

    it("answers the extension's proof by itself, behind the login", () => {
        const script = renderProxyScript({ tor: false });
        const login = script.indexOf("if device is None");
        const proof = script.indexOf(`http://${PROXY_PROOF_HOST}/`);
        expect(proof).toBeGreaterThan(login);
        expect(proof).toBeLessThan(script.indexOf('if method == "CONNECT"'));
    });

    it("trusts only the probe's own line", () => {
        expect(edgeIsReady("welcome\nedge=ready\n")).toBe(true);
        expect(edgeIsReady("said edge=ready once\n")).toBe(false);
    });

    it("reads only ids that are ids", () => {
        const id = "11111111-1111-4111-8111-111111111112";
        expect(parseProxyUsage(`${id} 5\n${"-".repeat(36)} 9\n`)).toEqual([
            { userId: id, used: 5n }
        ]);
    });
});

describe("a node that does not answer", () => {
    const script = wg.renderArrivalCount(51820);

    it("parses as shell", () => {
        expect(() => execFileSync("sh", ["-n"], { input: script, stdio: "pipe" })).not.toThrow();
    });

    it("counts only its own port, adding the counter on a node set up before it", () => {
        expect(script).toContain("nft list counter inet polaris_vpn arrivals_51820");
        expect(script).toContain(
            "nft insert rule inet polaris_vpn input udp dport 51820 counter name arrivals_51820"
        );
        expect(wg.renderArrivalCount(40000)).toContain("udp dport 40000 counter name arrivals_40000");
    });

    it("reads nft's own counter output", () => {
        const listed = "table inet polaris_vpn {\n\tcounter arrivals_51820 {\n\t\tpackets 7 bytes 91\n\t}\n}\n";
        const count = script.split("\n").find((line) => line.startsWith("count()")) ?? "";
        const said = execFileSync("sh", ["-c", `nft() { printf '%s' "$LISTED"; }\n${count}\ncount`], {
            env: { ...process.env, LISTED: listed },
            stdio: "pipe"
        });
        expect(said.toString().trim()).toBe("7");
    });

    it("tells a port nothing reaches from one that is reached", () => {
        expect(wg.arrivalVerdict("before=12\nafter=12\n")).toBe("blocked");
        expect(wg.arrivalVerdict("before=12\nafter=19\n")).toBe("open");
        expect(wg.arrivalVerdict("")).toBeNull();
        expect(wg.arrivalVerdict("before=3\n")).toBeNull();
    });
});
