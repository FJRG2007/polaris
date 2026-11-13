"use server";

import { requirePermission } from "@/lib/session";
import { listChannels } from "@/lib/messaging-service";

export async function loadChannelsAction() {
    const user = await requirePermission("inbox.read");
    return { channels: await listChannels(user.id) };
}

