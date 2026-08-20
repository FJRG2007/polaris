/**
 * The tab-icon choice, as it is offered on the notifications page.
 *
 * Rendered as the server renders it, which is the state a reader sees first:
 * before storage has been read the control has to stand somewhere, and the only
 * safe place for it to stand is where a reader who has never touched it is.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The settings view is a client component that reaches for the router and for
// server actions; the card under test needs neither.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

vi.mock("@/app/(app)/account/notifications/actions", () => ({
    saveNotificationRuleAction: vi.fn(),
    createDestinationAction: vi.fn(),
    deleteDestinationAction: vi.fn(),
    setDestinationEnabledAction: vi.fn(),
    testDestinationAction: vi.fn(),
    createSmsSenderAction: vi.fn(),
    deleteSmsSenderAction: vi.fn(),
    saveSmsSenderAction: vi.fn(),
    testSmsSenderAction: vi.fn()
}));

const { NotificationSettingsView } = await import(
    "@/app/(app)/account/notifications/notification-settings-view"
);

function render() {
    return renderToStaticMarkup(
        <NotificationSettingsView rules={[]} destinations={[]} senders={[]} deliveries={[]} />
    );
}

describe("the tab icon setting", () => {
    it("offers all three answers", () => {
        const markup = render();
        expect(markup).toContain("Tab icon");
        expect(markup).toContain(">Count<");
        expect(markup).toContain(">Dot<");
        expect(markup).toContain(">Nothing<");
    });

    it("starts on the count, which is the one worth having without opening the tab", () => {
        const markup = render();
        const group = markup.slice(
            markup.indexOf('aria-label="What the tab icon shows when something is waiting"')
        );
        const count = group.indexOf(">Count<");
        expect(group.slice(0, count)).toContain('aria-checked="true"');
        expect(group.slice(count, group.indexOf(">Dot<"))).not.toContain('aria-checked="true"');
    });
});
