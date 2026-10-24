// @vitest-environment jsdom
/**
 * The notification groups fold. A folded group says how many of its events
 * reach you, and which groups are open is remembered in this browser. A muted
 * group says until when, with the button that unmutes it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    NOTIFICATION_EVENTS,
    defaultRule,
    type NotificationHolds,
    type NotificationRule
} from "@polaris/core";

vi.mock("../../src/app/(app)/account/notifications/actions", () => ({}));

const { EventGroups, groupSummary } =
    await import("../../src/app/(app)/account/notifications/event-groups");

const deploy = NOTIFICATION_EVENTS.filter((entry) => entry.group === "deploy");
const OFF: NotificationRule = { inapp: false, email: false, destinations: [] };
const ON: NotificationRule = { inapp: true, email: false, destinations: [] };

function rules(offIds: string[]): Map<string, NotificationRule> {
    return new Map(
        NOTIFICATION_EVENTS.map((entry) => [
            entry.id,
            offIds.includes(entry.id) ? OFF : entry.group === "deploy" ? ON : defaultRule(entry)
        ])
    );
}

function show(
    state: Map<string, NotificationRule>,
    holds: NotificationHolds = { mutes: {}, schedules: {} }
) {
    const onMute = vi.fn();
    render(
        <MessagesWrapper>
            <EventGroups
                state={state}
                destinations={[]}
                onChange={() => {}}
                hold={{ holds, timeZone: "UTC", onMute, onSchedule: () => {} }}
            />
        </MessagesWrapper>
    );
    return { onMute };
}

let kept = new Map<string, string>();
beforeEach(() => {
    // jsdom here hands out no local storage.
    kept = new Map();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value),
            removeItem: (key: string) => void kept.delete(key),
            clear: () => kept.clear()
        }
    });
});
afterEach(cleanup);

describe("notification groups", () => {
    it("counts the events that reach somewhere", () => {
        const off = deploy.slice(0, 2).map((entry) => entry.id);
        expect(groupSummary(deploy, rules(off))).toEqual({
            on: deploy.length - 2,
            total: deploy.length
        });
    });

    it("starts folded with the summary, opens on click and remembers it", () => {
        const off = [deploy[0]!.id];
        show(rules(off));
        const header = screen.getByRole("button", { name: /^Deploy/ });
        expect(header.getAttribute("aria-expanded")).toBe("false");
        expect(header.textContent).toContain(`${deploy.length - 1} of ${deploy.length} on`);
        expect(screen.queryByText("Deploy failed")).toBeNull();

        fireEvent.click(header);
        expect(header.getAttribute("aria-expanded")).toBe("true");
        expect(document.getElementById("notify-group-deploy")?.querySelectorAll("li").length).toBe(
            deploy.length
        );
        expect(
            JSON.parse(window.localStorage.getItem("polaris.notifications.openGroups")!)
        ).toEqual(["deploy"]);

        cleanup();
        show(rules(off));
        expect(screen.getByRole("button", { name: /^Deploy/ }).getAttribute("aria-expanded")).toBe(
            "true"
        );
    });

    it("still works when storage throws", () => {
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            get: () => {
                throw new Error("blocked");
            }
        });
        {
            show(rules([]));
            expect(
                screen.getByRole("button", { name: /^Deploy/ }).getAttribute("aria-expanded")
            ).toBe("false");
        }
    });

    it("shows a muted group and unmutes it", () => {
        const { onMute } = show(rules([]), {
            mutes: { "group:deploy": { until: null } },
            schedules: {}
        });
        expect(screen.getAllByText("Muted").length).toBeGreaterThan(0);
        fireEvent.click(screen.getAllByRole("button", { name: "Unmute" })[0]!);
        expect(onMute).toHaveBeenCalledWith({ kind: "group", id: "deploy" }, null);
    });
});
