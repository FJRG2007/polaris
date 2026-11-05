/**
 * The old address of the chat settings (/admin/chat). Chat is a Polaris app, so
 * its settings live with the other apps' now: Polaris apps > Chat > Settings.
 */

import { permanentRedirect } from "next/navigation";
import { CHAT_SETTINGS_PATH } from "@/lib/apps/app-settings";

export default function ChatSettingsMoved(): never {
    permanentRedirect(CHAT_SETTINGS_PATH);
}
