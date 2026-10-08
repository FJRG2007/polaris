/**
 * A channel's settings page (`/chat/c/<id>/settings/<section>`).
 *
 * The page lives in the layout rather than in the section's page, so moving
 * between sections changes the address without dropping what is being edited:
 * a layout stays mounted while the segment under it changes. Authorization is
 * the actions' - an id in the URL is a request, not a permission - and the page
 * itself draws nothing but a refusal for somebody who may not change it.
 */

import type { ReactNode } from "react";
import { ChannelSettings } from "@/app/(app)/chat/channel-settings";

export const dynamic = "force-dynamic";

export default async function ChannelSettingsLayout({
    params
}: {
    children: ReactNode;
    params: Promise<{ channelId: string }>;
}) {
    const { channelId } = await params;
    return <ChannelSettings channelId={channelId} />;
}
