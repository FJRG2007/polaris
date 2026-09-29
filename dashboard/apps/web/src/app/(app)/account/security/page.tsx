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
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { SecurityView } from "./security-view";
import { listPasskeys } from "./passkey-actions";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getSuccessor } from "@/lib/successor-service";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { currentDeviceStanding } from "@/lib/device-grace";
import { listUserSessions } from "@/lib/session-directory";
import { accountLifecycle } from "@/lib/account-lifecycle";
import { getInstanceSecurity } from "@/lib/instance-security";
import type { ConnectedSignIn } from "./connected-sign-in-card";
import { describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import { CONNECTION_PROVIDERS, findConnectionProvider } from "@polaris/core";
import { connectionSignInAllowed, listConnections } from "@/lib/connections/store";
import {
    backupCodesRemaining,
    countTrustedDevices,
    getUserSecurity,
    listSecurityQuestions,
    twoFactorEnabled,
    type DeviceStanding
} from "@polaris/auth";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why this browser may not change anything here yet, in the reader's language.
 * The same sentence `newDeviceWaitMessage` in @polaris/auth writes in English.
 */
function waitMessage(standing: DeviceStanding, t: NamespaceTranslator<"accountSecurity">): string {
    if (!standing.settlesAt) return t("newDevice.unrecognized");
    const left = Math.max(1, Math.ceil((standing.settlesAt.getTime() - Date.now()) / DAY_MS));
    return t("newDevice.waiting", { grace: standing.graceDays, left });
}

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
                async (provider) =>
                    [provider.slug, await connectionSignInAllowed(provider.slug)] as const
            )
        )
    );
    // A typed name is not an account anybody signed in to, so it is not offered
    // as a way in - a switch beside it would be one that can never turn on.
    return linked.filter((account) => account.method !== "manual").map((account) => {
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
        instancePolicy,
        successor,
        mail,
        lifecycle,
        account,
        t
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
        // Only for the switch that asks for the second step after one of them:
        // the instance can have settled it already, and a switch that says
        // otherwise would be lying about what happens at the next sign-in.
        getInstanceSecurity(),
        getSuccessor(user.id),
        // Only for the emailed-link switch: with no channel to send from there is
        // nowhere for the link to go, and the switch says so instead of turning on.
        getAuthMailStatus(),
        // What the account is doing to itself: locked down, switched off, or on
        // its way out.
        accountLifecycle(user.id),
        // The handle itself, so the username switch names it rather than talking
        // about a concept.
        prisma.user.findUnique({ where: { id: user.id }, select: { username: true } }),
        getTranslations("accountSecurity")
    ]);
    const lock = standing.settled ? undefined : { reason: waitMessage(standing, t) };

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("page.intro")}</p>
            </div>
            <Messages namespaces={["accountSecurity", "validation"]}>
                <SecurityView
                    lock={lock}
                    account={user.email}
                    newDeviceGraceDays={settings.newDeviceGraceDays}
                    hasPin={settings.hasPin}
                    idleLockMinutes={settings.idleLockMinutes}
                    bindSessionsToClient={settings.bindSessionsToClient}
                    pinSessionsToAddress={settings.pinSessionsToAddress}
                    standing={lifecycle}
                    sessionMaxMinutes={settings.sessionMaxMinutes}
                    requireLoginApproval={settings.requireLoginApproval}
                    emailLinkSignIn={settings.emailLinkSignIn}
                    usernameSignIn={settings.usernameSignIn}
                    username={account?.username ?? ""}
                    canSendMail={mail.channelId !== null}
                    twoFactorEnabled={hasTwoFactor}
                    backupCodesRemaining={backupCodes}
                    questions={questions.map((entry) => entry.question)}
                    passkeys={passkeys}
                    twoFactorMethods={methods}
                    trustedDevices={trustedDevices}
                    twoFactorPreferred={settings.twoFactorPreferred}
                    connections={connections}
                    connectionChallenge={{
                        enabled: settings.challengeConnectionSignIn,
                        enforced: instancePolicy.challengeConnectionSignIn
                    }}
                    otherSessions={sessions.filter((session) => !session.current).length}
                    successor={
                        successor
                            ? {
                                  userId: successor.userId,
                                  name: successor.name,
                                  contact: successor.contact
                              }
                            : null
                    }
                />
            </Messages>
        </div>
    );
}
