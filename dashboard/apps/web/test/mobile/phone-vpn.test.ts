// @vitest-environment jsdom
/**
 * The phone app's VPN, as the VPN page sees it: the same shape as the desktop
 * app's, answered through the callback the app calls when a request ends.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { onPhoneVpnChange, phoneVpn } from "@/lib/mobile-bridge";

type Answer = (id: string, error: string) => void;

function installApp(outcome: string) {
    const sent: { id: string; input: string }[] = [];
    const app = {
        canVpn: () => true,
        vpnDeviceName: () => "Pixel 9",
        vpnKey: () => "public-key",
        vpnStatus: () => JSON.stringify({ nodeId: "node-1" }),
        vpnUp: (id: string, input: string) => {
            sent.push({ id, input });
            setTimeout(() => (window as unknown as { __polarisMobileVpn: Answer }).__polarisMobileVpn(id, outcome), 0);
        },
        vpnDown: (id: string) => {
            setTimeout(() => (window as unknown as { __polarisMobileVpn: Answer }).__polarisMobileVpn(id, ""), 0);
        }
    };
    (window as unknown as { polarisMobile: unknown }).polarisMobile = app;
    return sent;
}

const CONNECTION = {
    nodeId: "node-1",
    address: "10.128.0.2",
    dns: ["1.1.1.1"],
    nodePublicKey: "server-key",
    endpoint: "vpn.example.com",
    port: 51820
};

afterEach(() => {
    delete (window as unknown as { polarisMobile?: unknown }).polarisMobile;
});

describe("the phone's VPN", () => {
    it("is absent in a browser and in an app without it", () => {
        expect(phoneVpn()).toBeNull();
        (window as unknown as { polarisMobile: unknown }).polarisMobile = { platform: () => "android" };
        expect(phoneVpn()).toBeNull();
    });

    it("connects with what Polaris answered and says it worked", async () => {
        const sent = installApp("");
        const vpn = phoneVpn();
        expect(await vpn?.key()).toBe("public-key");
        expect(await vpn?.deviceName()).toBe("Pixel 9");
        expect(await vpn?.up(CONNECTION)).toEqual({ ok: true });
        expect(JSON.parse(sent[0]?.input ?? "{}")).toEqual(CONNECTION);
        expect(await vpn?.status()).toEqual({ nodeId: "node-1" });
        expect(await vpn?.down()).toEqual({ ok: true });
    });

    it("passes on the app's reason when it could not connect", async () => {
        installApp("noAnswer");
        expect(await phoneVpn()?.up(CONNECTION)).toEqual({ ok: false, error: "noAnswer" });
    });

    it("hears the tile turn the tunnel off", () => {
        const heard = vi.fn();
        const stop = onPhoneVpnChange(heard);
        window.dispatchEvent(new Event("polaris-mobile-vpn"));
        stop();
        window.dispatchEvent(new Event("polaris-mobile-vpn"));
        expect(heard).toHaveBeenCalledTimes(1);
    });
});
