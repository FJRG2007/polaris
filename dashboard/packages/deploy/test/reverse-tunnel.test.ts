/**
 * Reverse-tunnel plumbing. The port has to be stable per app and never shared with
 * another one (both ends bake it in - the forward and the server's route), the ssh
 * arguments have to fail loudly rather than sit on a forward that carries nothing, and
 * the setup script runs on a machine the operator uses: it may not corrupt the files
 * it appends to, nor hand its key more than the forward it exists for.
 */

import { describe, expect, it } from "vitest";
import {
    parseTunnelSetup,
    reverseTunnelArgv,
    reverseTunnelConfig,
    reverseTunnelName,
    reverseTunnelPort,
    tunnelSetupScript,
    DEFAULT_TUNNEL_BIND_ADDRESS
} from "../src/reverse-tunnel.js";

const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const OTHER = "019f8506-683f-7dd0-9c13-1e9ee9237fe4";
const SPEC = {
    appId: APP,
    hostname: "invoices.apps.example.com",
    localHost: "192.168.1.20",
    localPort: 24680,
    remotePort: reverseTunnelPort(APP),
    bindAddress: "10.42.0.1"
};

describe("reverseTunnelPort", () => {
    it("is stable for an app, so a restart keeps its port", () => {
        expect(reverseTunnelPort(APP)).toBe(reverseTunnelPort(APP));
    });

    it("separates two apps", () => {
        expect(reverseTunnelPort(APP)).not.toBe(reverseTunnelPort(OTHER));
    });

    it("stays out of the deploy and ephemeral ranges", () => {
        for (const id of [APP, OTHER, "a", "b", "c"]) {
            expect(reverseTunnelPort(id)).toBeGreaterThanOrEqual(42000);
            expect(reverseTunnelPort(id)).toBeLessThan(46000);
        }
    });

    it("steps past a port another tunnel already holds on that server", () => {
        const first = reverseTunnelPort(APP);
        expect(reverseTunnelPort(APP, [first])).toBe(first + 1);
        expect(reverseTunnelPort(APP, [first, first + 1])).toBe(first + 2);
    });

    it("throws rather than handing out a port that is already forwarding", () => {
        const taken = Array.from({ length: 4000 }, (_, index) => 42000 + index);
        expect(() => reverseTunnelPort(APP, taken)).toThrow(/no free tunnel port/i);
    });
});

describe("reverseTunnelArgv", () => {
    const argv = reverseTunnelArgv(SPEC, {
        host: "vps.example.com",
        port: 22,
        username: "root",
        keyPath: "/tmp/polaris_tunnel"
    });

    it("forwards the app's port back through the gateway the server reported", () => {
        expect(argv).toContain(`10.42.0.1:${SPEC.remotePort}:192.168.1.20:24680`);
        expect(argv.at(-1)).toBe("root@vps.example.com");
    });

    it("exits when the forward cannot be bound, so the restart policy retries", () => {
        expect(argv).toContain("ExitOnForwardFailure=yes");
        expect(argv).toContain("ServerAliveInterval=30");
    });

    it("authenticates with the dedicated key only", () => {
        expect(argv).toContain("-i");
        expect(argv[argv.indexOf("-i") + 1]).toBe("/tmp/polaris_tunnel");
    });
});

describe("reverseTunnelConfig", () => {
    const yaml = reverseTunnelConfig(SPEC);

    it("routes the hostname to the forwarded port with a real certificate", () => {
        expect(yaml).toContain("rule: \"Host(`invoices.apps.example.com`)\"");
        expect(yaml).toContain(`url: "http://10.42.0.1:${SPEC.remotePort}"`);
        expect(yaml).toContain("certResolver: letsencrypt");
    });

    it("points at the same port the forward binds, whatever it was allocated", () => {
        const moved = reverseTunnelConfig({ ...SPEC, remotePort: 43999 });
        expect(moved).toContain('url: "http://10.42.0.1:43999"');
    });

    it("names the router after the app, so one file per tunnel never collides", () => {
        expect(yaml).toContain(`${reverseTunnelName(APP)}:`);
        expect(reverseTunnelName(APP)).not.toBe(reverseTunnelName(OTHER));
    });
});

describe("tunnelSetupScript", () => {
    const script = tunnelSetupScript();

    it("is safe to re-run: it only mints and authorizes a key that is missing", () => {
        expect(script).toContain("if [ ! -f ~/.ssh/polaris_tunnel ]; then");
        expect(script).toContain("if ! grep -qF");
        expect(script).toContain("GatewayPorts clientspecified");
    });

    it("starts each append on its own line, so a file with no trailing newline survives", () => {
        expect(script).toContain("printf '\\n%s %s\\n'");
        expect(script).toContain("printf '\\nGatewayPorts clientspecified\\n'");
        expect(script).not.toContain("cat ~/.ssh/polaris_tunnel.pub >> ~/.ssh/authorized_keys");
    });

    it("authorizes the key for port forwarding and nothing else", () => {
        expect(script).toContain("restrict,port-forwarding");
    });

    it("prefers a drop-in, which sshd reads before the rest of the main file", () => {
        expect(script).toContain("/etc/ssh/sshd_config.d/00-polaris-tunnel.conf");
    });

    it("asks the server where its Docker gateway is instead of assuming one", () => {
        expect(script).toContain("docker network inspect");
        expect(script).toContain("polaris-proxy");
        expect(script).toContain("polaris-bind=%s");
    });
});

describe("parseTunnelSetup", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

    it("reads the key and the gateway the server reported", () => {
        const result = parseTunnelSetup(`polaris-bind=10.42.0.1\n${key}\n`);
        expect(result.key).toBe(key);
        expect(result.bindAddress).toBe("10.42.0.1");
    });

    it("falls back to the stock gateway when the server said nothing usable", () => {
        expect(parseTunnelSetup(`polaris-bind=<no value>\n${key}`).bindAddress).toBe(DEFAULT_TUNNEL_BIND_ADDRESS);
        expect(parseTunnelSetup(key).bindAddress).toBe(DEFAULT_TUNNEL_BIND_ADDRESS);
    });

    it("reports no key rather than a truncated one", () => {
        expect(parseTunnelSetup("polaris-bind=10.42.0.1\n").key).toBeNull();
        expect(parseTunnelSetup("-----BEGIN OPENSSH PRIVATE KEY-----\nabc").key).toBeNull();
    });
});
