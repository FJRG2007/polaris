// @vitest-environment jsdom

/**
 * The account's own code steps behave like sign-in: a confirmation that asks for
 * a delivered code sends it by itself on opening, once, with a resend that waits;
 * a whole code confirms without the button; enrolling the email factor sends its
 * code on entry and submits a whole one.
 */

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendStepUpCodeAction = vi.fn(async () => ({}) as { error?: string });
const proveStepUpAction = vi.fn(async () => ({}) as { error?: string });
const stepUpOptions = vi.fn(async () => ({
    choices: [{ proof: "email", label: "Email", target: "f***@example.test", sends: true }]
}));
const sendEnrollmentCodeAction = vi.fn(async () => ({}) as { error?: string });
const armByEmailAction = vi.fn(async () => ({ backupCodes: ["aaaa-bbbb"] }) as { error?: string; backupCodes?: string[] });

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ authClient: { twoFactor: {} } }));
vi.mock("@/app/(app)/account/step-up-actions", () => ({ sendStepUpCodeAction, proveStepUpAction }));
vi.mock("@/components/shared-polls", () => ({ stepUpOptions }));
vi.mock("@/app/oauth/enroll/actions", () => ({
    sendEnrollmentCodeAction,
    armByEmailAction,
    noteAuthenticatorArmedAction: vi.fn()
}));
vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));

const { StepUpDialog } = await import("@/components/step-up-dialog");
const { EmailFactor } = await import("@/app/oauth/enroll/enroll-view");

beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
});
afterEach(() => cleanup());

async function flush() {
    await act(async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
    });
}

function typeCode(value: string) {
    fireEvent.change(screen.getByPlaceholderText(/stepUp.codePlaceholder|000000/), { target: { value } });
}

describe("second-factor confirmation dialog", () => {
    const dialog = (onProved = vi.fn()) => (
        <StepUpDialog
            open
            purpose="connected-sign-in"
            title="Confirm"
            description="Prove it"
            onOpenChange={vi.fn()}
            onProved={onProved}
        />
    );

    it("sends an emailed code once on opening, even under StrictMode, and waits before a resend", async () => {
        render(<StrictMode>{dialog()}</StrictMode>);
        await flush();
        expect(sendStepUpCodeAction).toHaveBeenCalledTimes(1);
        expect(sendStepUpCodeAction).toHaveBeenCalledWith("connected-sign-in", "email");
        const resend = screen.getByRole("button", { name: /stepUp.sendAgainIn/ });
        expect((resend as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/stepUp.sentTo/)).toBeTruthy();
    });

    it("does not send again when reopened inside the wait", async () => {
        const first = render(dialog());
        await flush();
        first.unmount();
        render(dialog());
        await flush();
        expect(sendStepUpCodeAction).toHaveBeenCalledTimes(1);
    });

    it("confirms by itself once the whole code is typed, and not on a partial one", async () => {
        const onProved = vi.fn();
        render(dialog(onProved));
        await flush();
        typeCode("12345");
        await flush();
        expect(proveStepUpAction).not.toHaveBeenCalled();
        typeCode("123 456");
        await flush();
        expect(proveStepUpAction).toHaveBeenCalledWith("connected-sign-in", { proof: "email", code: "123456" });
        expect(onProved).toHaveBeenCalledTimes(1);
    });

    it("shows the reason when the send fails, and lets the person ask again", async () => {
        sendStepUpCodeAction.mockResolvedValueOnce({ error: "No mailbox." });
        render(dialog());
        await flush();
        expect(screen.getByText("No mailbox.")).toBeTruthy();
        const button = screen.getByRole("button", { name: /stepUp.send/ });
        expect((button as HTMLButtonElement).disabled).toBe(false);
    });
});

describe("email factor enrollment", () => {
    it("sends the code on entry, once, with the resend waiting", async () => {
        render(
            <StrictMode>
                <EmailFactor target="f***@example.test" password="secret" onArmed={vi.fn()} onBack={null} />
            </StrictMode>
        );
        await flush();
        expect(sendEnrollmentCodeAction).toHaveBeenCalledTimes(1);
        const resend = screen.getByRole("button", { name: /twoFactor.sendAgainIn/ });
        expect((resend as HTMLButtonElement).disabled).toBe(true);
    });

    it("turns the factor on by itself once the whole code is typed", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        try {
            const onArmed = vi.fn();
            render(<EmailFactor target="f***@example.test" password="secret" onArmed={onArmed} onBack={null} />);
            await flush();
            typeCode("654321");
            await act(async () => {
                vi.runAllTimers();
            });
            await flush();
            expect(armByEmailAction).toHaveBeenCalledWith("secret", "654321");
            expect(onArmed).toHaveBeenCalledWith(["aaaa-bbbb"]);
        } finally {
            vi.useRealTimers();
        }
    });
});
