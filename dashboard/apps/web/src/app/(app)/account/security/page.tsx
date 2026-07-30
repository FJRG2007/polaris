/**
 * Security page (/account/security): the controls that decide how the account is
 * proven and how long a session survives - password, authenticator, quick-unlock
 * PIN, recovery questions, session limits, and the sign-in approval gate.
 *
 * The page only reports state; every change goes through a server action that
 * re-verifies the password or another proof of identity.
 */

import { getUserPhone, getUserSecurity, listSecurityQuestions, twoFactorEnabled } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { listUserSessions } from "@/lib/session-directory";
import { describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import { listPasskeys } from "./passkey-actions";
import { SecurityView } from "./security-view";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
    const user = await requireUser();
    const [settings, questions, hasTwoFactor, passkeys, phone, methods, sessions, whatsappChannel] =
        await Promise.all([
            getUserSecurity(user.id),
            listSecurityQuestions(user.id),
            twoFactorEnabled(user.id),
            listPasskeys(),
            getUserPhone(user.id),
            describeTwoFactorMethods(user.id),
            // Approving a sign-in is done from another open session, so the card says
            // how many there are rather than offering a gate with nothing behind it.
            listUserSessions(user.id, user.sessionId),
            // Confirming a number is sent the same way the codes are, so the card
            // needs to know whether there is anything to send with.
            prisma.channel.findFirst({
                where: { ownerId: user.id, platform: "whatsapp", status: "connected" },
                select: { id: true }
            })
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
                phone={phone}
                canSendWhatsApp={whatsappChannel !== null}
                twoFactorMethods={methods}
                twoFactorPreferred={settings.twoFactorPreferred}
                otherSessions={sessions.filter((session) => !session.current).length}
            />
        </div>
    );
}
