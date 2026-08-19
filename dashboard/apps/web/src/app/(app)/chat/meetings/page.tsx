/**
 * Meetings (/chat/meetings).
 *
 * The list is fetched by the client that keeps it live, like every other screen
 * in Chat: what is running and who is in it changes while somebody is looking at
 * it, and the header is on screen before anything has been asked for.
 */

import { MeetingsView } from "./meetings-view";

export const dynamic = "force-dynamic";

export default function MeetingsPage() {
    return <MeetingsView />;
}
