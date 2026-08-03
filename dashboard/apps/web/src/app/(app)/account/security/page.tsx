/**
 * Security page (/account/security): the controls that decide how the account is
 * proven and how long a session survives - password, authenticator, quick-unlock
 * PIN, recovery questions, session limits, and the sign-in approval gate.
 *
 * The page only reports state; every change goes through a server action that
 * re-verifies the password or another proof of identity.
 */

import { requireUser } from "@/lib/session";
import { SecurityView } from "./security-view";
import { listPasskeys } from "./passkey-actions";
import { listUserSessions } from "@/lib/session-directory";
import { describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import {
    countTrustedDevices,
    getUserSecurity,
    listSecurityQuestions,
    twoFactorEnabled
} from "@polaris/auth";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
    const user = await requireUser();
    const [settings, questions, hasTwoFactor, passkeys, methods, sessions, trustedDevices] =
        await Promise.all([
            getUserSecurity(user.id),
            listSecurityQuestions(user.id),
            twoFactorEnabled(user.id),
            listPasskeys(),
            describeTwoFactorMethods(user.id),
            // Approving a sign-in is done from another open session, so the card says
            // how many there are rather than offering a gate with nothing behind it.
            listUserSessions(user.id, user.sessionId),
            countTrustedDevices(user.id)
        ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Security</h1>
                <p className="text-sm text-muted-foreground">
                    How you prove it is you, and how long a session stays open.
                </p>
            </div>
            <SecurityView
                hasPin={settings.hasPin}
                idleLockMinutes={settings.idleLockMinutes}
                sessionMaxMinutes={settings.sessionMaxMinutes}
                requireLoginApproval={settings.requireLoginApproval}
                twoFactorEnabled={hasTwoFactor}
                questions={questions.map((entry) => entry.question)}
                passkeys={passkeys}
                twoFactorMethods={methods}
                trustedDevices={trustedDevices}
                twoFactorPreferred={settings.twoFactorPreferred}
                otherSessions={sessions.filter((session) => !session.current).length}
            />
        </div>
    );
}
