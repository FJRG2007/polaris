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

describe("the sound setting", () => {
    it("is offered switched on, so an alert is not silently missed", () => {
        const markup = renderToStaticMarkup(
            <NotificationSettingsView rules={[]} destinations={[]} senders={[]} deliveries={[]} />
        );
        const switchMarkup = markup.slice(markup.indexOf('aria-label="Play a sound when a notification arrives"') - 200);
        expect(markup).toContain("Play a chime when a notification arrives");
        expect(switchMarkup).toContain('aria-checked="true"');
    });
});
