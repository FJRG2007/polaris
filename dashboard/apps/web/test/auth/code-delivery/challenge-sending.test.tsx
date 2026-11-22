// @vitest-environment jsdom

/**
 * The challenge screen sends a delivered code by itself, once - not again under
 * React's doubled effects, not again on a reload inside the wait - and an
 * authenticator never sends anything.
 */

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendOtp = vi.fn(async () => ({ data: { status: true }, error: null as null | { status: number; retryAfterSeconds?: number } }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({
    authClient: { twoFactor: { sendOtp, verifyOtp: vi.fn(), verifyTotp: vi.fn(), verifyBackupCode: vi.fn() } }
}));
vi.mock("@/app/oauth/2fa/actions", () => ({ abandonChallengeAction: vi.fn() }));
vi.mock("@/app/oauth/login/post-login-target", () => ({ landAfterSignIn: vi.fn() }));
vi.mock("@/app/oauth/2fa/phone-approval", () => ({ PhoneApproval: () => null }));
vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));

const { TwoFactorView } = await import("@/app/oauth/2fa/two-factor-view");

const telegram = {
    methods: [
        { method: "telegram" as const, target: "Telegram" },
        { method: "totp" as const, target: null }
    ],
    preferred: "telegram" as const
};

beforeEach(() => {
    sendOtp.mockClear();
    window.sessionStorage.clear();
});
afterEach(() => cleanup());

async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe("TwoFactorView code sending", () => {
    it("sends a Telegram code once on entry, even under StrictMode, and counts down the resend", async () => {
        render(
            <StrictMode>
                <TwoFactorView options={telegram} phoneApproval={false} />
            </StrictMode>
        );
        await flush();
        expect(sendOtp).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/twoFactor.sentTo/)).toBeTruthy();
        const resend = screen.getByRole("button", { name: /twoFactor.sendAgainIn/ });
        expect((resend as HTMLButtonElement).disabled).toBe(true);
    });

    it("does not send again on a reload inside the wait", async () => {
        const first = render(<TwoFactorView options={telegram} phoneApproval={false} />);
        await flush();
        first.unmount();
        render(<TwoFactorView options={telegram} phoneApproval={false} />);
        await flush();
        expect(sendOtp).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: /twoFactor.sendAgainIn/ })).toBeTruthy();
    });

    it("never sends for the authenticator, and switching to it shows no send button", async () => {
        render(<TwoFactorView options={{ ...telegram, preferred: "totp" }} phoneApproval={false} />);
        await flush();
        expect(sendOtp).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: /twoFactor.send/ })).toBeNull();
    });

    it("sends when switching from the authenticator to Telegram, and not again on switching back and forth", async () => {
        render(<TwoFactorView options={{ ...telegram, preferred: "totp" }} phoneApproval={false} />);
        await flush();
        fireEvent.click(screen.getByText("twoFactor.methods.telegram.label"));
        await flush();
        expect(sendOtp).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByText("twoFactor.methods.totp.label"));
        fireEvent.click(screen.getByText("twoFactor.methods.telegram.label"));
        await flush();
        expect(sendOtp).toHaveBeenCalledTimes(1);
    });

    it("takes the server's wait when it refuses a send", async () => {
        sendOtp.mockResolvedValueOnce({ data: null as never, error: { status: 429, retryAfterSeconds: 12 } });
        render(<TwoFactorView options={telegram} phoneApproval={false} />);
        await flush();
        expect(screen.getByRole("button", { name: /"seconds":12/ })).toBeTruthy();
    });
});
