/**
 * The security-key step (/oauth/security-key). Shown when this Polaris requires
 * the account to sign in with a passkey or a security key and the current session
 * was opened some other way - a password, an emailed link, a connected account.
 *
 * It stands between a valid session and the dashboard, which makes the requirement
 * retroactive: a session opened before an administrator turned it on meets it at
 * its next request. The way through is a new sign-in with a key; an account with
 * none registers one here first, since Account > Security is behind this step.
 *
 * Resolves the session directly rather than through requireUser, which would send
 * the person back here forever.
 */

import { prisma } from "@polaris/db";
import { redirect } from "next/navigation";
import { resolveSession } from "@/lib/session";
import { SecurityKeyView } from "./security-key-view";
import { Messages } from "@/components/i18n/messages";
import { owesPhishingResistantSignIn } from "@/lib/instance-security";

export const dynamic = "force-dynamic";

export default async function SecurityKeyPage() {
    const session = await resolveSession();
    if (!session) redirect("/oauth/login");
    // Nothing owed is also how a finished sign-in leaves this page.
    if (!(await owesPhishingResistantSignIn(session.id, session.sessionId))) redirect("/");

    const keys = await prisma.passkey.findMany({
        where: { userId: session.id },
        select: { credentialID: true, transports: true, name: true },
        orderBy: { createdAt: "asc" }
    });
    return (
        // Account > Security's words, for the refusals a registration can answer with.
        <Messages namespaces={["accountSecurity"]}>
            <SecurityKeyView
                account={session.email}
                name={session.name}
                keys={keys.map((key) => ({
                    id: key.credentialID,
                    transports: key.transports ? key.transports.split(",") : []
                }))}
                names={keys.map((key) => key.name ?? "")}
            />
        </Messages>
    );
}
