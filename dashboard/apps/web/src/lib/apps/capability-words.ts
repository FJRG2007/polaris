/**
 * The words for each app capability, as `marketplace.capabilities.*` keys: the
 * badges a store card and an app's page show, and the public site's copy of them.
 */

import type { AppCapability } from "@/lib/apps/catalog";
import type { NamespaceKey } from "@/lib/i18n/types";

export const CAPABILITY_KEYS: Record<AppCapability, NamespaceKey<"marketplace">> = {
    "messaging-hub": "capabilities.messagingHub",
    "messaging-channel": "capabilities.messagingChannel",
    "ai-assistant": "capabilities.aiAssistant",
    "game-manager": "capabilities.gameManager",
    "game-server": "capabilities.gameServer",
    "camera-hub": "capabilities.cameraHub",
    "mqtt-broker": "capabilities.mqttBroker",
    "home-hub": "capabilities.homeHub",
    "mail-server": "capabilities.mailServer",
    "dns-blocker": "capabilities.dnsBlocker",
    tool: "capabilities.tool"
};
