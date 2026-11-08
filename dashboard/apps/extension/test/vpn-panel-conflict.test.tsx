// @vitest-environment jsdom

/**
 * The VPN screen while another extension holds the proxy: the card is where the
 * status is, connecting waits for it, and Disable takes the proxy back without
 * another press.
 */

import type { VpnState } from "../src/lib/vpn";
import { VpnPanel } from "../src/entrypoints/popup/vpn-panel";
import { shareVpnState } from "../src/entrypoints/popup/vpn-row";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const NODE = {
    id: "node-1",
    name: "Madrid",
    exit: "direct",
    browser: true,
    browserIssue: null,
    country: "ES",
    city: "Madrid"
};

const HELD: VpnState = {
    available: true,
    nodes: [NODE],
    active: null,
    webRtcGuard: null,
    conflict: {
        kind: "extensions",
        extensions: [{ id: "other-vpn", name: "Other VPN", icon: null, mayDisable: true }]
    }
};

let asked: { kind: string }[] = [];
let current: VpnState = HELD;
const setEnabled = vi.fn(async () => undefined);

beforeEach(() => {
    asked = [];
    current = HELD;
    setEnabled.mockClear();
    vi.stubGlobal("browser", {
        runtime: {
            sendMessage: async (request: { kind: string }) => {
                asked.push(request);
                if (request.kind === "vpnReclaim") current = { ...HELD, conflict: null };
                return { ok: true, vpn: current };
            }
        },
        management: { setEnabled },
        permissions: { request: async () => true }
    });
    shareVpnState(HELD);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the VPN screen with the proxy held elsewhere", () => {
    it("shows who holds it and keeps Quick connect off until it is free", async () => {
        await act(async () => {
            render(<VpnPanel />);
        });
        expect(screen.getByText("Other VPN")).toBeTruthy();
        const quick = screen.getByRole("button", { name: /Quick connect/ });
        expect((quick as HTMLButtonElement).disabled).toBe(true);
    });

    it("disables it on the press and takes the proxy back", async () => {
        await act(async () => {
            render(<VpnPanel />);
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Disable Other VPN" }));
        });
        expect(setEnabled).toHaveBeenCalledWith("other-vpn", false);
        expect(asked.map((request) => request.kind)).toContain("vpnReclaim");
        expect(screen.queryByText("Other VPN")).toBeNull();
        const quick = screen.getByRole("button", { name: /Quick connect/ });
        expect((quick as HTMLButtonElement).disabled).toBe(false);
    });

    it("tries the refused connect again once the proxy is free", async () => {
        const free = { ...HELD, conflict: null };
        let connects = 0;
        vi.stubGlobal("browser", {
            runtime: {
                sendMessage: async (request: { kind: string }) => {
                    asked.push(request);
                    if (request.kind === "vpnConnect") {
                        connects += 1;
                        if (connects === 1) {
                            current = HELD;
                            return { ok: false, error: "Another extension controls the proxy." };
                        }
                        const active = { nodeId: "node-1", nodeName: "Madrid", since: null };
                        return { ok: true, vpn: { ...free, active } };
                    }
                    if (request.kind === "vpnReclaim") current = free;
                    return { ok: true, vpn: current };
                }
            },
            management: { setEnabled },
            permissions: { request: async () => true }
        });
        current = free;
        shareVpnState(free);
        await act(async () => {
            render(<VpnPanel />);
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /Quick connect/ }));
        });
        expect(screen.getByText("Other VPN")).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Disable Other VPN" }));
        });
        expect(connects).toBe(2);
        expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    });
    it("redraws when the extension is turned off somewhere else", async () => {
        let disabled: () => void = () => undefined;
        const listen = { addListener: () => undefined, removeListener: () => undefined };
        vi.stubGlobal("browser", {
            runtime: {
                sendMessage: async (request: { kind: string }) => {
                    asked.push(request);
                    return { ok: true, vpn: current };
                }
            },
            proxy: { settings: { onChange: listen } },
            management: {
                setEnabled,
                onEnabled: listen,
                onInstalled: listen,
                onUninstalled: listen,
                onDisabled: {
                    addListener: (listener: () => void) => (disabled = listener),
                    removeListener: () => undefined
                }
            },
            permissions: { request: async () => true }
        });
        await act(async () => {
            render(<VpnPanel />);
        });
        expect(screen.getByText("Other VPN")).toBeTruthy();
        current = { ...HELD, conflict: null };
        await act(async () => {
            disabled();
        });
        expect(screen.queryByText("Other VPN")).toBeNull();
    });
});
