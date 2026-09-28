/**
 * The Deploy and Containers screens used to ask the host daemon for its health on
 * every visit before they painted. The snapshot the background refresh keeps is
 * served when it already says yes; only a "no", which may just be behind, still
 * asks the daemon, so a daemon that has just come up shows at once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITED_CAPABILITIES, setCapabilities, type Capabilities } from "@polaris/config";

const { refreshCapabilities } = vi.hoisted(() => ({ refreshCapabilities: vi.fn() }));
vi.mock("@polaris/hostd-client", () => ({ refreshCapabilities }));

const { capabilitiesFor } = await import("../../src/lib/host-capabilities");

const FULL: Capabilities = {
    ...LIMITED_CAPABILITIES,
    edition: "full",
    hostd: { present: true, version: "1.0.0" },
    docker: true,
    deploy: true
};

beforeEach(() => {
    refreshCapabilities.mockReset();
    setCapabilities(LIMITED_CAPABILITIES);
});

describe("capabilitiesFor", () => {
    it("serves the snapshot without asking the daemon when it already has the capability", async () => {
        setCapabilities(FULL);
        expect(await capabilitiesFor("docker")).toBe(FULL);
        expect(await capabilitiesFor("deploy")).toBe(FULL);
        expect(refreshCapabilities).not.toHaveBeenCalled();
    });

    it("asks the daemon when the snapshot says the capability is missing", async () => {
        refreshCapabilities.mockResolvedValueOnce(FULL);
        expect(await capabilitiesFor("docker")).toBe(FULL);
        expect(refreshCapabilities).toHaveBeenCalledTimes(1);
    });

    it("asks again for a capability the snapshot lacks even when it has another", async () => {
        setCapabilities({ ...FULL, deploy: false });
        refreshCapabilities.mockResolvedValueOnce(LIMITED_CAPABILITIES);
        expect(await capabilitiesFor("deploy")).toBe(LIMITED_CAPABILITIES);
        expect(refreshCapabilities).toHaveBeenCalledTimes(1);
    });
});
