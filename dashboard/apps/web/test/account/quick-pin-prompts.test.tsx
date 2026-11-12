// @vitest-environment jsdom

/**
 * Every screen that asks for the quick PIN checks it on its last digit once the
 * account knows how long it is - once, not again for the same PIN - and waits
 * for the button while it does not. A wrong PIN empties the box and leaves the
 * cursor in it for the next try.
 */

import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls = vi.hoisted(() => ({ pins: [] as string[], answer: {} as { error?: string } }));
function check(pin: string) {
    calls.pins.push(pin);
    return Promise.resolve(calls.answer);
}

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key })
}));
vi.mock("@/components/i18n/use-nav-label", () => ({ useNavLabel: () => (label: string) => label }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/relative-time", () => ({ RelativeTime: () => null }));
vi.mock("@/lib/auth-client", () => ({ signOut: async () => null }));
vi.mock("@/app/(app)/app-lock/actions", () => ({
    unlockAppAction: ({ pin }: { pin: string }) => check(pin)
}));
vi.mock("@/app/oauth/lock/actions", () => ({ unlockSessionAction: (secret: string) => check(secret) }));
vi.mock("@/app/(app)/account/scan/actions", () => ({
    decideQrSignInAction: ({ pin }: { pin: string }) => check(pin)
}));
vi.mock("@/app/(app)/account/sessions/actions", () => ({
    decideLoginApprovalAction: (_id: string, _approve: boolean, pin: string) => check(pin)
}));

import { LockView } from "@/app/oauth/lock/lock-view";
import { pinReady } from "@/components/quick-pin-input";
import type { SessionView } from "@/lib/session-directory";
import { ScanView } from "@/app/(app)/account/scan/scan-view";
import { AppUnlockView } from "@/app/(app)/app-lock/unlock-view";
import { ApproveSignInDialog } from "@/app/(app)/account/sessions/sessions-view";

interface Prompt {
    name: string;
    label: string;
    button: string;
    render: (length: number | null) => ReactElement;
}

const later = new Date(Date.now() + 10 * 60_000).toISOString();

const PROMPTS: Prompt[] = [
    {
        name: "a locked app",
        label: "lock.pin",
        button: "lock.unlock",
        render: (length) => <AppUnlockView appId="chat" label="Chat" next="/chat" pinLength={length} />
    },
    {
        name: "the lock screen",
        label: "lock.pin",
        button: "lock.unlock",
        render: (length) => <LockView name="Ada" email="ada@example.test" hasPin pinLength={length} />
    },
    {
        name: "a QR sign-in",
        label: "scan.decide.pin",
        button: "scan.decide.allow",
        render: (length) => (
            <ScanView
                scanned
                hasPin
                pinLength={length}
                request={{
                    userCode: "ABCD-EFGH",
                    device: "Firefox on Linux",
                    origin: "192.0.2.1",
                    host: null,
                    requestedAt: new Date().toISOString(),
                    expiresAt: later
                }}
            />
        )
    },
    {
        name: "a sign-in approval",
        label: "sessions.approve.pin",
        button: "sessions.pending.approve",
        render: (length) => (
            <ApproveSignInDialog
                session={{ id: "session-2", device: "Firefox" } as SessionView}
                pinLength={length}
                onOpenChange={() => undefined}
                onApproved={() => undefined}
            />
        )
    }
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
    calls.pins = [];
    calls.answer = {};
});
afterEach(cleanup);

describe.each(PROMPTS)("the PIN on $name", (prompt) => {
    it.each([4, 5, 6])("is checked on digit %i and not before", async (length) => {
        calls.answer = { error: "wrong" };
        render(prompt.render(length));
        const box = screen.getByLabelText(prompt.label) as HTMLInputElement;
        const pin = "123456".slice(0, length);
        for (let typed = 1; typed < length; typed++) {
            fireEvent.change(box, { target: { value: pin.slice(0, typed) } });
            await tick();
        }
        expect(calls.pins).toEqual([]);
        fireEvent.change(box, { target: { value: pin } });
        await waitFor(() => expect(calls.pins).toEqual([pin]));
        await tick();
        expect(calls.pins).toEqual([pin]);
    });

    it("is checked once when the button follows the last digit", async () => {
        calls.answer = { error: "wrong" };
        render(prompt.render(4));
        const box = screen.getByLabelText(prompt.label) as HTMLInputElement;
        fireEvent.change(box, { target: { value: "1234" } });
        fireEvent.click(screen.getByRole("button", { name: prompt.button }));
        await tick();
        await tick();
        expect(calls.pins).toEqual(["1234"]);
    });

    it("empties and keeps the cursor after a wrong PIN", async () => {
        calls.answer = { error: "wrong" };
        render(prompt.render(4));
        const box = screen.getByLabelText(prompt.label) as HTMLInputElement;
        box.focus();
        fireEvent.change(box, { target: { value: "1234" } });
        await waitFor(() => expect(box.value).toBe(""));
        expect(calls.pins).toEqual(["1234"]);
        expect(document.activeElement).toBe(box);
    });

    it("waits for the button while the length is not known", async () => {
        render(prompt.render(null));
        const box = screen.getByLabelText(prompt.label) as HTMLInputElement;
        for (const value of ["1234", "12345", "123456"]) {
            fireEvent.change(box, { target: { value } });
            await tick();
        }
        expect(calls.pins).toEqual([]);
        fireEvent.click(screen.getByRole("button", { name: prompt.button }));
        await waitFor(() => expect(calls.pins).toEqual(["123456"]));
    });
});

describe("a PIN worth checking", () => {
    it("is the known length exactly, or 4 to 6 digits when unknown", () => {
        expect(pinReady("123", 4)).toBe(false);
        expect(pinReady("1234", 4)).toBe(true);
        expect(pinReady("1234", 6)).toBe(false);
        expect(pinReady("123", null)).toBe(false);
        expect(pinReady("1234", null)).toBe(true);
        expect(pinReady("123456", null)).toBe(true);
        expect(pinReady("1234567", null)).toBe(false);
    });
});
