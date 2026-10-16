// @vitest-environment jsdom

/**
 * The Rollouts screen: its headings paint before the answer, a halted rollout
 * says why and offers Resume and Roll back, and a server's waiting command reads
 * "Waiting for the server" with a cancel that takes it off at once.
 */

import { MessagesWrapper } from "../../setup/i18n";
import type { RolloutScreen } from "@/lib/agent-rollouts/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const COMMAND = "0192d3a4-5b6c-7d8e-9f00-000000000001";

let answer: Promise<{ ok: true; value: RolloutScreen }>;
const cancel = vi.fn(async () => ({ ok: true as const, value: undefined }));
const control = vi.fn(async () => ({ ok: true as const, value: undefined }));
const history = vi.fn(async (_serverId: string) => ({
    ok: true as const,
    value: [
        {
            id: "0192d3a4-5b6c-7d8e-9f00-000000000002",
            kind: "container.stop",
            target: "worker",
            status: "done",
            result: "done",
            createdAt: "2026-10-16T11:00:00.000Z",
            expiresAt: "2026-10-17T11:00:00.000Z"
        }
    ]
}));

vi.mock("../../../src/app/(app)/apps/servers/rollouts/actions", () => ({
    rolloutScreenAction: () => answer,
    startRolloutAction: async () => ({ ok: true, value: undefined }),
    rolloutControlAction: (action: string) => control(action),
    setPinAction: async () => ({ ok: true, value: undefined }),
    enqueueCommandAction: async () => ({ ok: true, value: { status: "queued" } }),
    cancelCommandAction: (id: string) => cancel(id),
    commandHistoryAction: (serverId: string) => history(serverId)
}));

const { RolloutsView, parseWaveInput } = await import(
    "../../../src/app/(app)/apps/servers/rollouts/rollouts-view"
);

const data: RolloutScreen = {
    servers: [
        {
            id: "local",
            name: "this-box",
            version: "1.0.0",
            heartbeatAt: "2026-10-16T12:00:00.000Z",
            online: true,
            pinnedVersion: null,
            waiting: [],
            assignments: []
        },
        {
            id: "0192d3a4-5b6c-7d8e-9f00-112233445566",
            name: "web-1",
            version: null,
            heartbeatAt: null,
            online: false,
            pinnedVersion: null,
            waiting: [
                {
                    id: COMMAND,
                    kind: "container.restart",
                    target: "api",
                    status: "queued",
                    result: null,
                    createdAt: "2026-10-16T12:00:00.000Z",
                    expiresAt: "2026-10-17T12:00:00.000Z"
                }
            ],
            assignments: []
        }
    ],
    rollout: {
        id: "r1",
        version: "2.0.0",
        previousVersion: "1.0.0",
        status: "halted",
        wave: 0,
        waves: [1, 100],
        healthMinutes: 10,
        haltReason: "failed",
        createdAt: "2026-10-16T12:00:00.000Z",
        targets: [
            {
                serverId: "local",
                wave: 0,
                state: "failed",
                fromVersion: "1.0.0",
                error: "heartbeat"
            },
            {
                serverId: "0192d3a4-5b6c-7d8e-9f00-112233445566",
                wave: -1,
                state: "skipped",
                fromVersion: null,
                error: "no-agent"
            }
        ]
    }
};

beforeEach(() => {
    sessionStorage.clear();
    cancel.mockClear();
    control.mockClear();
    history.mockClear();
});
afterEach(cleanup);

describe("the Rollouts screen", () => {
    it("paints its headings before the answer arrives", () => {
        answer = new Promise(() => {});
        render(<RolloutsView />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("heading", { name: "Rollout" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Servers" })).toBeTruthy();
        expect(
            (screen.getByRole("button", { name: "Start rollout" }) as HTMLButtonElement).disabled
        ).toBe(true);
    });

    it("says why a rollout halted, per server, and offers resume and roll back", async () => {
        answer = Promise.resolve({ ok: true, value: data });
        render(<RolloutsView />, { wrapper: MessagesWrapper });
        expect(
            await screen.findByText(
                "Halted because a server failed its health check. Retry it, or roll back."
            )
        ).toBeTruthy();
        expect(screen.getByTitle("this-box: Failed - Stopped answering")).toBeTruthy();
        expect(screen.getByTitle("web-1: Skipped - Managed over SSH")).toBeTruthy();
        expect(
            (screen.getByRole("button", { name: "Start rollout" }) as HTMLButtonElement).disabled
        ).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Resume" }));
        await waitFor(() => expect(control).toHaveBeenCalledWith("resume"));
    });

    it("shows a waiting command and cancels it at once", async () => {
        answer = Promise.resolve({ ok: true, value: data });
        render(<RolloutsView />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(/Waiting for the server/)).toBeTruthy();
        expect(screen.getByText("Managed over SSH", { selector: "dd" })).toBeTruthy();
        // What the server answers once the cancel has landed.
        answer = Promise.resolve({
            ok: true,
            value: { ...data, servers: data.servers.map((server) => ({ ...server, waiting: [] })) }
        });
        fireEvent.click(screen.getByRole("button", { name: "Cancel command" }));
        await waitFor(() => expect(cancel).toHaveBeenCalledWith(COMMAND));
        expect(screen.queryByText(/Waiting for the server/)).toBeNull();
    });
});

describe("a server's commands", () => {
    it("reads its finished commands only when they are opened", async () => {
        answer = Promise.resolve({ ok: true, value: data });
        render(<RolloutsView />, { wrapper: MessagesWrapper });
        await screen.findByText(/Waiting for the server/);
        expect(history).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Recent" }));
        expect(await screen.findByText(/worker/)).toBeTruthy();
        expect(history).toHaveBeenCalledWith("0192d3a4-5b6c-7d8e-9f00-112233445566");
    });

    it("draws the first page of a long server list and the rest on request", async () => {
        const many = Array.from({ length: 60 }, (_, index) => ({
            ...data.servers[0]!,
            id: `0192d3a4-5b6c-7d8e-9f00-${String(index).padStart(12, "0")}`,
            name: `box-${index}`
        }));
        answer = Promise.resolve({ ok: true, value: { ...data, servers: many } });
        render(<RolloutsView />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("box-49")).toBeTruthy();
        expect(screen.queryByText("box-50")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Show more" }));
        expect(await screen.findByText("box-59")).toBeTruthy();
    });
});

describe("parseWaveInput", () => {
    it("reads a canary and rising percentages, and refuses anything else", () => {
        expect(parseWaveInput("1, 10, 50, 100")).toEqual([1, 10, 50, 100]);
        expect(parseWaveInput("1, 50")).toBeNull();
        expect(parseWaveInput("one, 100")).toBeNull();
    });
});
