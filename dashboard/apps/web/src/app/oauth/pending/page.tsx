/**
 * The waiting room (/oauth/pending). A sign-in landed here because the account
 * requires new sessions to be approved from one that is already open. The session
 * exists but may do nothing until that decision is made, so this page resolves it
 * directly rather than through requireUser.
 *
 * A denial deletes the session outright, which turns the next poll into a plain
 * "signed out" - there is no state here that survives a refusal.
 */

import { redirect } from "next/navigation";
import { prisma } from "@polaris/db";
import { resolveSession } from "@/lib/session";
import { PendingView } from "./pending-view";

export const dynamic = "force-dynamic";

export default async function PendingPage() {
    const session = await resolveSession();
    if (!session) redirect("/oauth/login");

    const state = await prisma.sessionState.findUnique({
        where: { sessionId: session.sessionId },
        select: { approval: true, createdAt: true }
    });
    if (!state || state.approval === "approved") redirect("/drive");
    if (state.approval === "denied") redirect("/oauth/login?denied=1");

    return <PendingView requestedAt={state.createdAt.toISOString()} />;
}
