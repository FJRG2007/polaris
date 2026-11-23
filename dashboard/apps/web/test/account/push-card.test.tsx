// @vitest-environment jsdom
/**
 * Inside Polaris Desktop the notices card never offers a Web Push subscription:
 * Electron has no push service, so it could only fail. It says the app shows
 * the notices itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key
}));
vi.mock("@/app/(app)/account/notifications/actions", () => ({
    pushKeyAction: vi.fn(),
    subscribePushAction: vi.fn(),
    unsubscribePushAction: vi.fn()
}));
const desktop = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/desktop-bridge", () => ({ desktopBridge: () => desktop.value }));
vi.mock("@/lib/mobile-bridge", () => ({ inPhoneApp: () => false }));

const { PushCard } = await import("@/app/(app)/account/notifications/push-card");

afterEach(() => {
    cleanup();
    desktop.value = null;
});

describe("notices on this device", () => {
    it("inside Polaris Desktop says the app shows them, with nothing to subscribe", async () => {
        desktop.value = { version: "0.1.54" };
        render(<PushCard />);
        expect(await screen.findByText("push.standing.desktop")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "push.turnOn" })).toBeNull();
    });

    it("in a browser without push says so for a browser", async () => {
        render(<PushCard />);
        expect(await screen.findByText('push.standing.unsupported:{"clientKind":"other"}')).toBeTruthy();
    });
});
