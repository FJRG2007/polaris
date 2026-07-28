/**
 * Security page (/account/security): the controls that decide how the account is
 * proven and how long a session survives - password, authenticator, quick-unlock
 * PIN, recovery questions, session limits, and the sign-in approval gate.
 *
 * The page only reports state; every change goes through a server action that
 * re-verifies the password or another proof of identity.
 */

import { getUserSecurity, listSecurityQuestions, twoFactorEnabled } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { SecurityView } from "./security-view";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
    const user = await requireUser();
    const [settings, questions, hasTwoFactor] = await Promise.all([
        getUserSecurity(user.id),
        listSecurityQuestions(user.id),
        twoFactorEnabled(user.id)
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
            />
        </div>
    );
}
