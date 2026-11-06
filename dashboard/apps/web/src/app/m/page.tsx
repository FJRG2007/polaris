/**
 * Joining a meeting with its code (/m).
 *
 * The other way through the same door as a meeting's link, for somebody who was
 * read the code over the phone or copied it off a screen. Outside the dashboard
 * shell, like the link itself: whoever types a code may have no account.
 */

import { getSession } from "@/lib/session";
import { JoinCodeForm } from "./join-code-form";
import { Messages } from "@/components/i18n/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function JoinCodePage() {
    const session = await getSession();
    return (
        <Messages namespaces={["chat"]}>
            <JoinCodeForm signedIn={Boolean(session?.user)} />
        </Messages>
    );
}
