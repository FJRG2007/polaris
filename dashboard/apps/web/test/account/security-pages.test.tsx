/**
 * The Security area is four pages drawn by one view: each shows only its own
 * cards, so nothing is shown twice and nothing is lost in the split.
 *
 * Rendered to static markup with every server action stubbed: these are
 * assertions about which cards a page draws, not about what they do.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_POLICY } from "@/lib/two-factor-policy";

/** A module whose every export is an action that does nothing. */
function stubActions(): Record<string, unknown> {
    return new Proxy({}, { get: (_, key) => (key === "then" ? undefined : async () => ({})) });
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => "/" }));
vi.mock("../../src/app/(app)/account/security/actions", () => stubActions());
vi.mock("../../src/app/(app)/account/security/two-factor-actions", () => stubActions());
vi.mock("../../src/app/(app)/account/security/passkey-actions", () => stubActions());
vi.mock("../../src/app/(app)/account/security/lifecycle-actions", () => stubActions());
vi.mock("../../src/app/(app)/account/security/successor-actions", () => stubActions());
vi.mock("../../src/app/(app)/account/step-up-actions", () => stubActions());
vi.mock("@/app/device-account-actions", () => stubActions());
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => stubActions());

const { SecurityView } = await import("../../src/app/(app)/account/security/security-view");
type Part = Parameters<typeof SecurityView>[0]["part"];

function render(part: Part): string {
    return renderToStaticMarkup(
        withMessages(
            <SecurityView
                part={part}
                account="fixture@example.test"
                newDeviceGraceDays={3}
                hasPin
                idleLockMinutes={15}
                bindSessionsToClient={false}
                pinSessionsToAddress="none"
                standing={{ lockedDown: false, lockdownSince: null, lockdownNote: "", closure: null, daysLeft: 0 }}
                sessionMaxMinutes={60}
                requireLoginApproval={false}
                emailLinkSignIn={false}
                usernameSignIn={false}
                autoPasskey={false}
                username="fixture"
                canSendMail={false}
                twoFactorEnabled
                backupCodesRemaining={8}
                questions={[]}
                passkeys={[]}
                twoFactorMethods={[]}
                twoFactorPreferred="totp"
                twoFactorPolicy={DEFAULT_POLICY}
                trustedDevices={0}
                connections={[]}
                connectionChallenge={{ enabled: false, enforced: false }}
                otherSessions={0}
                successor={null}
            />
        )
    );
}

/** Words only its own card says, in en-US: a title, or the backup codes count. */
const PASSWORD = "Password";
const AUTHENTICATOR = "Authenticator app";
const BACKUP = "8 left";

describe("the Security pages", () => {
    it("keeps the password and session limits on the first page, without the second step", () => {
        const markup = render("sign-in");
        expect(markup).toContain(PASSWORD);
        expect(markup).not.toContain(AUTHENTICATOR);
        expect(markup).not.toContain(BACKUP);
    });

    it("draws the authenticator only on the two-factor page", () => {
        const markup = render("two-factor");
        expect(markup).toContain(AUTHENTICATOR);
        expect(markup).not.toContain(BACKUP);
    });

    it("draws backup codes only on the recovery page", () => {
        const markup = render("recovery");
        expect(markup).toContain(BACKUP);
        expect(markup).not.toContain(AUTHENTICATOR);
    });

    it("draws nothing but passkeys on the passkeys page", () => {
        const markup = render("passkeys");
        expect(markup).not.toContain(AUTHENTICATOR);
        expect(markup).not.toContain(BACKUP);
    });
});
