/**
 * The messages this reader kept (/chat/saved).
 *
 * A bookmark with nowhere to go is not a bookmark, which is what starring would
 * be without this screen. Nothing is fetched here: the list is a live read
 * scoped to one person, and it belongs to the client that keeps the rest of Chat
 * live.
 */

import { SavedView } from "./saved-view";

export const dynamic = "force-dynamic";

export default function SavedPage() {
    return <SavedView />;
}
