/**
 * Sessions page (/account/sessions): every device currently signed in, and the
 * sign-ins waiting on a decision when approval is required. This is where a user
 * notices - and ends - access they did not expect.
 */

import { requireUser } from "@/lib/session";
import { SessionsView } from "./sessions-view";
import { listUserSessions } from "@/lib/session-directory";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
    const user = await requireUser();
    const sessions = await listUserSessions(user.id, user.sessionId);

    // Wider than the rest of the account pages: this one is a table, and the
    // address and domain columns are the point of it.
    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Sessions</h1>
                <p className="text-sm text-muted-foreground">Where your account is signed in right now.</p>
            </div>
            <SessionsView sessions={sessions} />
        </div>
    );
}
