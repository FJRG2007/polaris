/**
 * Sessions page (/account/sessions): every device currently signed in, the
 * sign-ins waiting on a decision when approval is required, and the browsers
 * allowed to skip the second-factor challenge. This is where a user notices -
 * and ends - access they did not expect.
 *
 * The remembered browsers belong here rather than on the security page beside
 * the setting that grants them: a pass is access, it outlives the session that
 * created it, and somebody hunting for a device they no longer have looks where
 * the devices are.
 */

import { requireUser } from "@/lib/session";
import { SessionsView } from "./sessions-view";
import { listTrustedDeviceRows, listUserSessions } from "@/lib/session-directory";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
    const user = await requireUser();
    const [sessions, trusted] = await Promise.all([
        listUserSessions(user.id, user.sessionId),
        listTrustedDeviceRows(user.id)
    ]);

    // Wider than the rest of the account pages: this one is a table, and the
    // address and domain columns are the point of it. Held to the same width as
    // the security page so the two read as one place.
    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Sessions</h1>
                <p className="text-sm text-muted-foreground">
                    Where your account is signed in, and which devices it stops asking.
                </p>
            </div>
            <SessionsView sessions={sessions} trusted={trusted} />
        </div>
    );
}
