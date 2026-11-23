// @vitest-environment jsdom
/**
 * Screens that name another Polaris product wear that product's logo beside the
 * name: Chat's "A file sent from Drive" setting, and every group of the
 * notification settings.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NOTIFICATION_EVENTS, defaultRule } from "@polaris/core";
import { notificationGroupMark } from "@/lib/notifications/group-apps";

vi.mock("../../src/app/(app)/account/notifications/actions", () => ({}));
vi.mock("../../src/app/(app)/admin/apps/[appId]/settings/_chat/actions", () => ({
    setDriveShareAction: vi.fn()
}));

const { EventGroups } = await import("../../src/app/(app)/account/notifications/event-groups");
const { DriveShareView } =
    await import("../../src/app/(app)/admin/apps/[appId]/settings/_chat/drive-share-view");

beforeEach(() => {
    const kept = new Map<string, string>();
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

describe("product marks where another product is named", () => {
    it("heads Chat's Drive setting with the Drive logo", () => {
        const { container } = render(<DriveShareView how="copy" />, { wrapper: MessagesWrapper });
        const title = screen.getByText("A file sent from Drive");
        expect(title.querySelector('svg[data-app-logo="drive"]')).not.toBeNull();
        expect(container.querySelectorAll("[data-app-logo]")).toHaveLength(1);
    });

    it("marks every notification group with its app's logo, or Polaris's own mark", () => {
        const state = new Map(NOTIFICATION_EVENTS.map((entry) => [entry.id, defaultRule(entry)]));
        const { container } = render(
            <EventGroups
                state={state}
                destinations={[]}
                onChange={() => {}}
                hold={{
                    holds: { mutes: {}, schedules: {} },
                    timeZone: "UTC",
                    onMute: () => {},
                    onSchedule: () => {}
                }}
            />,
            { wrapper: MessagesWrapper }
        );
        const marked = [...container.querySelectorAll("[data-app-logo]")].map((node) =>
            node.getAttribute("data-app-logo")
        );
        const groups = [...new Set(NOTIFICATION_EVENTS.map((entry) => entry.group))];
        const expected = groups.flatMap((group) => {
            const mark = notificationGroupMark(group);
            return mark.kind === "app" ? [mark.appId] : [];
        });
        expect(marked.sort()).toEqual(expected.sort());
        expect(marked).toEqual(expect.arrayContaining(["apps", "home", "router", "chat", "polar"]));
        expect(container.querySelectorAll("[data-group-mark]")).toHaveLength(2);
    });
});
