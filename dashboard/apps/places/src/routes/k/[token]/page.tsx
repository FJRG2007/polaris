/**
 * A door handed out as a link, as the person holding it sees it. No session:
 * the token is the right, and the core page around this has already checked
 * that it names a door and is in force now (`app/k/[[...path]]`). This reads
 * the door and draws the buttons the link allows.
 */

import { notFound } from "next/navigation";
import { guestKey } from "../../../lib/guest-key";
import { GuestKeyView } from "../../../screens/guest/guest-key-view";

export const dynamic = "force-dynamic";

export default async function GuestKeyPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { token } = await params;
    if (typeof token !== "string") notFound();
    const key = await guestKey(token);
    if (!key || key.standing !== "live") notFound();
    return (
        <GuestKeyView
            token={token}
            initial={key.device}
            allowed={key.allowed}
            nearbyMeters={key.nearbyMeters}
            until={key.until}
            note={key.note}
        />
    );
}
