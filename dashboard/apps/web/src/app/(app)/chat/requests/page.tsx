/**
 * Message requests waiting on this reader (/chat/requests): conversations from
 * people their "who can message me" leaves out. The shell draws at once; the
 * list is read by the client.
 */

import { RequestsView } from "./requests-view";

export const dynamic = "force-dynamic";

export default function RequestsPage() {
    return <RequestsView />;
}
