// @vitest-environment jsdom

/**
 * A tunnel card once its live state arrives: connected with the readings, or
 * still waiting for the first handshake - and then the firewall rule with the
 * exact values, which goes away once the handshake happens.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TunnelView } from "@/lib/deploy/wireguard/tunnel-service";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const status = vi.hoisted(() => ({ reply: {} as unknown, calls: 0, ids: [] as string[][] }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../../../src/app/(app)/apps/tunnels/actions", () => ({
    createTunnelAction: vi.fn(),
    removeTunnelAction: vi.fn(),
    setTunnelPausedAction: vi.fn(),
    tunnelStatusesAction: vi.fn(async ({ ids }: { ids: string[] }) => {
        status.calls += 1;
        status.ids.push(ids);
        const reply = status.reply as { status?: unknown; error?: string };
        return reply.status
            ? { statuses: Object.fromEntries(ids.map((id) => [id, reply.status])) }
            : reply;
    })
}));

const { TunnelsView } = await import("../../../src/app/(app)/apps/tunnels/tunnels-view");

const TUNNEL: TunnelView = {
    id: "0190a8c4-0000-7000-8000-000000000001",
    hostname: "app.example.com",
    listenPort: 51821,
    paused: false,
    publicServer: { id: "0190a8c4-0000-7000-8000-0000000000aa", name: "edge-1" },
    service: {
        id: "0190a8c4-0000-7000-8000-0000000000bb",
        name: "web",
        project: "Shop",
        server: "home-box"
    },
    endpointHost: "203.0.113.7",
    createdAt: "2026-10-01T00:00:00.000Z"
};

const OPTIONS = { servers: [], services: [] };

beforeEach(() => {
    status.calls = 0;
    status.ids = [];
});

afterEach(cleanup);

describe("a live tunnel card", () => {
    it("shows connected with the bytes moved, and no firewall step", async () => {
        status.reply = {
            status: {
                health: "up",
                lastHandshake: Math.floor(Date.now() / 1000) - 30,
                rxBytes: 2048,
                txBytes: 1024
            }
        };
        render(<TunnelsView tunnels={[TUNNEL]} options={OPTIONS} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Connected")).toBeTruthy();
        expect(screen.getByText("Last handshake")).toBeTruthy();
        expect(screen.queryByText("Never")).toBeNull();
        expect(screen.queryByText(/Open UDP port/)).toBeNull();
    });

    it("until the first handshake, gives the exact rule to add at the provider", async () => {
        status.reply = { status: { health: "waiting", lastHandshake: 0, rxBytes: 0, txBytes: 0 } };
        render(<TunnelsView tunnels={[TUNNEL]} options={OPTIONS} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Open UDP port 51821 on edge-1")).toBeTruthy();
        expect(screen.getByText("Waiting")).toBeTruthy();
        expect(screen.getByText("Never")).toBeTruthy();
        expect(screen.getByText("UDP")).toBeTruthy();
        expect(screen.getByText("0.0.0.0/0")).toBeTruthy();
        expect(
            screen.getByText(
                "Point app.example.com at 203.0.113.7 with an A record so visitors reach it."
            )
        ).toBeTruthy();
    });

    it("does not send the operator to their firewall when neither server answered", async () => {
        status.reply = { status: { health: "unknown", lastHandshake: 0, rxBytes: 0, txBytes: 0 } };
        render(<TunnelsView tunnels={[TUNNEL]} options={OPTIONS} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Unknown")).toBeTruthy();
        expect(screen.queryByText(/Open UDP port/)).toBeNull();
    });

    it("reads every running card in one request", async () => {
        status.reply = {
            status: {
                health: "up",
                lastHandshake: Math.floor(Date.now() / 1000),
                rxBytes: 0,
                txBytes: 0
            }
        };
        const second = {
            ...TUNNEL,
            id: "0190a8c4-0000-7000-8000-000000000002",
            hostname: "two.example.com"
        };
        const paused = {
            ...TUNNEL,
            id: "0190a8c4-0000-7000-8000-000000000003",
            hostname: "three.example.com",
            paused: true
        };
        render(<TunnelsView tunnels={[TUNNEL, second, paused]} options={OPTIONS} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getAllByText("Connected")).toHaveLength(2));
        expect(status.calls).toBe(1);
        expect(status.ids[0]).toEqual([TUNNEL.id, second.id]);
    });

    it("says the state could not be read instead of spinning forever", async () => {
        status.reply = { error: "The tunnel could not be changed. Try again in a moment." };
        render(<TunnelsView tunnels={[TUNNEL]} options={OPTIONS} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("The tunnel's state could not be read.")).toBeTruthy();
    });

    it("reads nothing for a paused tunnel", async () => {
        render(<TunnelsView tunnels={[{ ...TUNNEL, paused: true }]} options={OPTIONS} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getByText("Paused")).toBeTruthy());
        expect(status.calls).toBe(0);
    });
});
