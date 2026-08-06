/**
 * Security page (/account/security): the controls that decide how the account is
 * proven and how long a session survives - password, authenticator, quick-unlock
 * PIN, recovery questions, session limits, and the sign-in approval gate.
 *
 * The page only reports state; every change goes through a server action that
 * re-verifies the password or another proof of identity.
 *
 * It also resolves whether this browser is old enough on the account to change
 * any of it. The actions refuse a device that is not either way; this is so the
 * page says so up front instead of letting somebody fill in a dialog that was
 * never going to be accepted.
 */

import { auth } from "@/lib/auth";
import { requireUser } from "@/lib/session";
import { SecurityView } from "./security-view";
import { listPasskeys } from "./passkey-actions";
import { getSuccessor } from "@/lib/successor-service";
import { currentDeviceStanding } from "@/lib/device-grace";
import { listUserSessions } from "@/lib/session-directory";
import type { ConnectedSignIn } from "./connected-sign-in-card";
import { describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import { CONNECTION_PROVIDERS, findConnectionProvider } from "@polaris/core";
import { connectionSignInAllowed, listConnections } from "@/lib/connections/store";
import {
    backupCodesRemaining,
    countTrustedDevices,
    getUserSecurity,
    listSecurityQuestions,
    newDeviceWaitMessage,
    twoFactorEnabled
} from "@polaris/auth";

export const dynamic = "force-dynamic";

/**
 * The accounts this person has connected, each with what the operator has
 * decided about that service. Both halves travel together because the switch is
 * meaningless without the other: on, under a service the operator has closed, it
 * would sit there looking like a way in that works.
 */
async function connectedSignIns(userId: string): Promise<ConnectedSignIn[]> {
    const linked = await listConnections(userId);
    const allowed = new Map<string, boolean>(
        await Promise.all(
            CONNECTION_PROVIDERS.map(
                async (provider) => [provider.slug, await connectionSignInAllowed(provider.slug)] as const
            )
        )
    );
    return linked.map((account) => {
        const provider = findConnectionProvider(account.provider);
        return {
            id: account.id,
            provider: account.provider,
            providerName: provider?.name ?? account.provider,
            label: account.label,
            signInEnabled: account.signInEnabled,
            allowedHere: allowed.get(account.provider) ?? false,
            warning: provider?.signInWarning
        };
    });
}

export default async function SecurityPage() {
    const user = await requireUser();
    const [
        settings,
        questions,
        hasTwoFactor,
        passkeys,
        methods,
        sessions,
        trustedDevices,
        backupCodes,
        standing,
        connections,
        successor
    ] = await Promise.all([
        getUserSecurity(user.id),
        listSecurityQuestions(user.id),
        twoFactorEnabled(user.id),
        listPasskeys(),
        describeTwoFactorMethods(user.id),
        // Approving a sign-in is done from another open session, so the card says
        // how many there are rather than offering a gate with nothing behind it.
        listUserSessions(user.id, user.sessionId),
        countTrustedDevices(user.id),
        // The count only. The codes are never read out to a page.
        backupCodesRemaining(auth, user.id),
        currentDeviceStanding(user),
        // The outside accounts this person has connected, and whether each may
        // sign them in - which is theirs to decide and the operator's to allow.
        connectedSignIns(user.id),
        getSuccessor(user.id)
    ]);
    const lock = standing.settled ? undefined : { reason: newDeviceWaitMessage(standing) };

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Security</h1>
                <p className="text-sm text-muted-foreground">
                    How you prove it is you, and how long a session stays open.
                </p>
            </div>
            <SecurityView
                lock={lock}
                account={user.email}
                newDeviceGraceDays={settings.newDeviceGraceDays}
                hasPin={settings.hasPin}
                idleLockMinutes={settings.idleLockMinutes}
                sessionMaxMinutes={settings.sessionMaxMinutes}
                requireLoginApproval={settings.requireLoginApproval}
                twoFactorEnabled={hasTwoFactor}
                backupCodesRemaining={backupCodes}
                questions={questions.map((entry) => entry.question)}
                passkeys={passkeys}
                twoFactorMethods={methods}
                trustedDevices={trustedDevices}
                twoFactorPreferred={settings.twoFactorPreferred}
                connections={connections}
                otherSessions={sessions.filter((session) => !session.current).length}
                successor={
                    successor ? { userId: successor.userId, name: successor.name, email: successor.email } : null
                }
            />
        </div>
    );
}
