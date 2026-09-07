/**
 * The server-onboarding script.
 *
 * The property worth pinning is the one that caused a week of wrong answers: the
 * build toolchain is UPGRADED to a known version, not merely installed when it is
 * missing. A machine onboarded a year ago keeps whatever nixpacks it got then, and
 * that single fact decides which language runtimes exist on it - an old build pins
 * Node 22 to an early release and answers a request for a newer major by silently
 * falling back to Node 18. None of that is visible until somebody's app fails its
 * own engine check, and every workaround for it is worse than the upgrade.
 */

import { describe, expect, it } from "vitest";
import { onboardingScript } from "../src/onboarding.js";

const script = onboardingScript({ proxyNetwork: "polaris-net", acmeEmail: "ops@example.com" });

describe("the edge it leaves running", () => {
    it("belongs to the server, so an app keeps answering without Polaris", () => {
        // The whole design: the domain resolves to this machine and this machine's
        // Traefik serves it. A control plane at the end of somebody's home
        // broadband must not be in the request path of a data-centre app.
        expect(script).toContain("docker run -d --name polaris-traefik");
        expect(script).toContain("-p 80:80 -p 443:443");
    });

    it("reads the labels a deployed container carries", () => {
        // What makes a service routed and firewalled the moment it starts, with
        // nothing for anybody to push.
        expect(script).toContain("--providers.docker=true");
    });

    it("also reads a directory Polaris can write into", () => {
        // For everything a label cannot express - a route that dials somewhere
        // other than the container it describes, which is what response rewriting
        // needs. Watched, or picking up a change would mean restarting the edge.
        expect(script).toContain("--providers.file.directory=/dynamic");
        expect(script).toContain("--providers.file.watch=true");
        expect(script).toContain("-v /var/lib/polaris/traefik/dynamic:/dynamic");
        expect(script).toContain("mkdir -p");
        expect(script).toContain("/var/lib/polaris/traefik/dynamic");
    });
});

describe("the build toolchain", () => {
    it("installs nixpacks, not only docker", () => {
        expect(script).toContain("nixpacks");
        expect(script).toContain("nixpacks.com/install.sh");
    });

    it("pins the version it wants rather than taking the newest", () => {
        // An unpinned installer makes two machines onboarded a month apart build
        // differently, which is the sort of difference nobody thinks to check.
        expect(script).toMatch(/NIXPACKS_WANT=\d+\.\d+\.\d+/);
    });

    it("upgrades when the version on the machine is not the one wanted", () => {
        // The whole point: `command_exists nixpacks` would have left the old one in
        // place forever.
        expect(script).toContain('if [ "$NIXPACKS_HAVE" != "$NIXPACKS_WANT" ]');
    });

    it("reports the version it ended up with, so a log says what built the image", () => {
        expect(script).toContain("nixpacks --version");
    });

    it("stays safe to re-run", () => {
        // Nothing in the added block removes or resets anything: it compares, and
        // installs only on a mismatch.
        expect(onboardingScript({ proxyNetwork: "polaris-net", acmeEmail: "ops@example.com" })).toBe(script);
        expect(script.startsWith("set -e")).toBe(true);
    });
});
