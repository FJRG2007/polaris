/**
 * The conversation with one person, found or started.
 *
 * Where a person picked in search goes. A conversation that already exists is
 * found while this page renders and gone to straight away - one navigation
 * rather than a page, a round trip from the browser and then a second page. One
 * that does not exist yet is opened by the same action the rail's "new message"
 * uses, from the browser rather than here: opening one can create it, and a
 * page that writes when it is fetched is a page a prefetch or a crawler writes
 * through. Finding one writes nothing.
 *
 * A refusal found here is handed to the browser as it is, so it says why
 * without asking the same question a second time.
 */

import * as core from "@polaris/core";
import { redirect } from "next/navigation";
import { OpenDirect } from "./open-direct";
import { requirePermission } from "@/lib/session";
import { ChatAccessError, existingDirect } from "@/lib/chat/chat-service";

export const dynamic = "force-dynamic";

export default async function ChatWithPage({ params }: { params: Promise<{ userId: string }> }) {
    const { userId } = await params;
    const user = await requirePermission("chat.use");

    // The same shape the action checks, so an address that is not a person is
    // left for it to explain rather than reaching the database here.
    const parsed = core.chatDirectOpenSchema.safeParse({ userIds: [userId] });
    if (!parsed.success) return <OpenDirect userId={userId} />;

    let found: string | null = null;
    try {
        found = await existingDirect({ id: user.id }, userId);
    } catch (caught) {
        if (!(caught instanceof ChatAccessError)) throw caught;
        return <OpenDirect userId={userId} refused={caught.message} />;
    }
    // Outside the try: a redirect is thrown, and it is not a refusal.
    if (found) redirect(`/chat/c/${found}`);
    return <OpenDirect userId={userId} />;
}
