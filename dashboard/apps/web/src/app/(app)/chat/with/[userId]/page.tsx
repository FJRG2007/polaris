/**
 * The conversation with one person, found or started.
 *
 * Where a person picked in search goes. The conversation is opened by the same
 * action the rail's "new message" uses, from the browser rather than while this
 * page renders: opening one can create it, and a page that writes when it is
 * fetched is a page a prefetch or a crawler writes through.
 */

import { OpenDirect } from "./open-direct";

export const dynamic = "force-dynamic";

export default async function ChatWithPage({ params }: { params: Promise<{ userId: string }> }) {
    const { userId } = await params;
    return <OpenDirect userId={userId} />;
}
