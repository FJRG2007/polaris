/**
 * A further screen of a built-in app's administrator settings - Chat's files
 * from Drive, organizations, link safety and calls. The first screen is the
 * settings page itself; an app or a screen that has none here is a 404.
 */

import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { ChatSettingsPage } from "../_chat/chat-screen";
import { isChatAdminScreen } from "../_chat/chat-settings";

export const dynamic = "force-dynamic";

export default async function AppSettingsScreenPage({
    params
}: {
    params: Promise<{ appId: string; screen: string }>;
}) {
    await requireAdmin();
    const { appId, screen } = await params;
    if (appId !== "chat" || screen === "" || !isChatAdminScreen(screen)) notFound();
    return <ChatSettingsPage screen={screen} />;
}
