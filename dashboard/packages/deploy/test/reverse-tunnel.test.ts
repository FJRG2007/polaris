/**
 * Reverse-tunnel plumbing. The port has to be stable per app (it is baked into both
 * ends - the forward and the server's route - and nothing stores it), and the ssh
 * arguments have to fail loudly rather than sit on a forward that carries nothing.
 */

import { describe, expect, it } from "vitest";
import {
    reverseTunnelArgv,
    reverseTunnelConfig,
    reverseTunnelName,
    reverseTunnelPort,
    tunnelSetupScript,
    TUNNEL_BIND_ADDRESS
} from "../src/reverse-tunnel.js";

const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const OTHER = "019f8506-683f-7dd0-9c13-1e9ee9237fe4";
const SPEC = { appId: APP, hostname: "invoices.apps.example.com", localHost: "192.168.1.20", localPort: 24680 };

describe("reverseTunnelPort", () => {
    it("is stable for an app, since both ends derive it independently", () => {
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
});

describe("reverseTunnelArgv", () => {
    const argv = reverseTunnelArgv(SPEC, {
        host: "vps.example.com",
        port: 22,
        username: "root",
        keyPath: "/tmp/polaris_tunnel"
    });

    it("forwards the app's port back through the server's bridge gateway", () => {
        expect(argv).toContain(`${TUNNEL_BIND_ADDRESS}:${reverseTunnelPort(APP)}:192.168.1.20:24680`);
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
        expect(yaml).toContain(`url: "http://${TUNNEL_BIND_ADDRESS}:${reverseTunnelPort(APP)}"`);
        expect(yaml).toContain("certResolver: letsencrypt");
    });

    it("names the router after the app, so one file per tunnel never collides", () => {
        expect(yaml).toContain(`${reverseTunnelName(APP)}:`);
        expect(reverseTunnelName(APP)).not.toBe(reverseTunnelName(OTHER));
    });
});

describe("tunnelSetupScript", () => {
    it("is safe to re-run: it only mints and authorizes a key that is missing", () => {
        const script = tunnelSetupScript();
        expect(script).toContain("if [ ! -f ~/.ssh/polaris_tunnel ]; then");
        expect(script).toContain("if ! grep -qF");
        expect(script).toContain("GatewayPorts clientspecified");
    });
});
