// @vitest-environment jsdom

/**
 * A webhook trigger's address, shown and copyable from the moment the trigger
 * is added - before the automation is saved - and replaced on request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const asked: unknown[][] = [];
const rotated: unknown[][] = [];

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({
    hookAddressAction: async (...args: unknown[]) => {
        asked.push(args);
        return { ok: true, path: `/api/automations/hooks/fixture-${String(args[2])}` };
    },
    rotateHookAction: async (...args: unknown[]) => {
        rotated.push(args);
        return { ok: true };
    },
    chatConversationsAction: async () => ({ ok: true, conversations: [] })
}));

const { MessagesWrapper } = await import("../setup/i18n");
const { WebhookAddress } = await import("@/app/(app)/automations/[id]/node-fields");
type Detail = Parameters<typeof WebhookAddress>[0]["detail"];

function detail(saved: boolean, hooks: Record<string, string> = {}): Detail {
    return {
        id: "auto-fixture",
        hooks,
        draft: {
            nodes: saved ? [{ id: "hook", type: "core.webhook", config: { rotation: 0 } }] : []
        }
    } as unknown as Detail;
}

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
}

beforeEach(() => {
    asked.length = 0;
    rotated.length = 0;
});

afterEach(() => cleanup());

describe("a webhook trigger's address", () => {
    it("is asked for and shown before the automation is saved", async () => {
        render(
            <WebhookAddress
                detail={detail(false)}
                nodeId="hook"
                rotation={0}
                onRotate={() => undefined}
                onChanged={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        await painted();
        expect(asked).toEqual([["auto-fixture", "hook", 0]]);
        expect(
            screen.getByText(`${window.location.origin}/api/automations/hooks/fixture-0`)
        ).toBeDefined();
    });

    it("uses the saved address without asking again", async () => {
        render(
            <WebhookAddress
                detail={detail(true, { hook: "/api/automations/hooks/saved" })}
                nodeId="hook"
                rotation={0}
                onRotate={() => undefined}
                onChanged={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );
        await painted();
        expect(asked).toEqual([]);
        expect(
            screen.getByText(`${window.location.origin}/api/automations/hooks/saved`)
        ).toBeDefined();
    });

    it("turns a new address locally while unsaved, and on the server once saved", async () => {
        const turns: number[] = [];
        const changed = vi.fn();
        const { unmount } = render(
            <WebhookAddress
                detail={detail(false)}
                nodeId="hook"
                rotation={0}
                onRotate={(next) => turns.push(next)}
                onChanged={changed}
            />,
            { wrapper: MessagesWrapper }
        );
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "New address" }));
        await painted();
        expect(turns).toEqual([1]);
        expect(rotated).toEqual([]);
        unmount();

        render(
            <WebhookAddress
                detail={detail(true, { hook: "/api/automations/hooks/saved" })}
                nodeId="hook"
                rotation={0}
                onRotate={(next) => turns.push(next)}
                onChanged={changed}
            />,
            { wrapper: MessagesWrapper }
        );
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "New address" }));
        await painted();
        expect(rotated).toEqual([["auto-fixture", "hook"]]);
        expect(turns).toEqual([1, 1]);
        expect(changed).toHaveBeenCalledTimes(1);
    });
});
