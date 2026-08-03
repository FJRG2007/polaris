/**
 * The lock screen (/oauth/lock). Shown when a session has idled past the user's
 * limit: the session is still valid, it is simply closed until they prove they
 * are still the one at the keyboard - with the quick PIN, or the account password
 * when no PIN is set.
 *
 * Resolves the session directly rather than through requireUser, which would
 * redirect a locked session back here forever.
 */

import { redirect } from "next/navigation";
import { getUserSecurity } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { resolveSession } from "@/lib/session";
import { LockView } from "./lock-view";

export const dynamic = "force-dynamic";

export default async function LockPage() {
    const session = await resolveSession();
    if (!session) redirect("/oauth/login");

    const state = await prisma.sessionState.findUnique({
        where: { sessionId: session.sessionId },
        select: { lockedAt: true }
    });
    if (!state?.lockedAt) redirect("/");

    const settings = await getUserSecurity(session.id);
    return <LockView name={session.name} email={session.email} hasPin={settings.hasPin} />;
}
