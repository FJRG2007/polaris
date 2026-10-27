// @vitest-environment jsdom

/**
 * A port card whose first read failed says so, with a way to try again, instead
 * of drawing nothing - so the Ports page never tells an administrator that
 * nothing needs a port when it could not read whether anything does.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const live = vi.hoisted(() => ({
    refresh: vi.fn(),
    state: {
        data: null,
        loading: false,
        error: "Request failed (500)",
        stale: null,
        refreshing: false
    }
}));

vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({ ...live.state, refresh: live.refresh, replace: vi.fn() })
}));
vi.mock("@/app/(app)/admin/domains/actions", () => ({}));
vi.mock("@/app/(app)/admin/domains/port-policy-form", () => ({ PortPolicyForm: () => null }));

import { PortsView } from "@/app/(app)/admin/domains/ports-view";
import { CallPortsCard } from "@/app/(app)/admin/domains/call-ports-card";
import { GamePortsCard } from "@/app/(app)/admin/domains/game-ports-card";

const FAILED = "These ports could not be read just now.";
const EMPTY = "Nothing on this server needs an open port right now.";

afterEach(() => {
    cleanup();
    live.refresh.mockClear();
});

describe("a port card whose read failed", () => {
    it.each([
        ["game", GamePortsCard, "game-ports"],
        ["call", CallPortsCard, "call-ports"]
    ])("the %s card says so and offers a retry", (_, Card, anchor) => {
        const onKnown = vi.fn();
        const view = render(withMessages(<Card onKnown={onKnown} />));

        expect(view.getByRole("alert").textContent).toBe(FAILED);
        expect(view.container.querySelector(`#${anchor}`)).not.toBeNull();
        expect(onKnown).toHaveBeenLastCalledWith(true);

        fireEvent.click(view.getByRole("button", { name: "Try again" }));
        expect(live.refresh).toHaveBeenCalledTimes(1);
    });

    it("keeps the Ports page from saying nothing needs a port", () => {
        const view = render(withMessages(<PortsView />));

        expect(view.getAllByRole("alert")).toHaveLength(2);
        expect(view.queryAllByTestId("ports-skeleton")).toHaveLength(0);
        expect(view.container.textContent).not.toContain(EMPTY);
    });
});
