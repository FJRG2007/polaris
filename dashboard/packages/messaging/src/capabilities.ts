/**
 * The per-platform capability matrix. The single source of truth for what each
 * channel can do, so the UI and the adapters agree on how an interactive prompt
 * should render (native buttons vs a poll vs a numbered menu).
 */

import type { ChannelCapabilities, Platform } from "./types.js";

/** Capabilities for a platform and, where it has more than one backend, its
 *  provider (WhatsApp web/cloud, and the send-only discord-webhook/slack-webhook). */
export function capabilitiesFor(platform: Platform, provider?: string | null): ChannelCapabilities {
    switch (platform) {
        case "telegram":
            return {
                nativeButtons: true,
                nativeSelects: true,
                polls: true,
                media: true,
                templates: false,
                banRisk: false,
                needsBrowser: false,
                onboarding: "token"
            };
        case "discord":
            // A webhook is send-only: no bot, no gateway, so no interactive/receive.
            return provider === "discord-webhook"
                ? {
                      nativeButtons: false,
                      nativeSelects: false,
                      polls: false,
                      media: false,
                      templates: false,
                      banRisk: false,
                      needsBrowser: false,
                      onboarding: "token"
                  }
                : {
                      nativeButtons: true,
                      nativeSelects: true,
                      polls: false,
                      media: true,
                      templates: false,
                      banRisk: false,
                      needsBrowser: false,
                      onboarding: "token"
                  };
        case "slack":
            return provider === "slack-webhook"
                ? {
                      nativeButtons: false,
                      nativeSelects: false,
                      polls: false,
                      media: false,
                      templates: false,
                      banRisk: false,
                      needsBrowser: false,
                      onboarding: "token"
                  }
                : {
                      nativeButtons: true,
                      nativeSelects: true,
                      polls: false,
                      media: true,
                      templates: false,
                      banRisk: false,
                      needsBrowser: false,
                      onboarding: "oauth"
                  };
        case "whatsapp":
            // The official Cloud API has native interactive messages and templates;
            // the free whatsapp-web backend has neither (buttons were deprecated),
            // so a selector degrades to a native poll or a numbered menu.
            return provider === "whatsapp-cloud"
                ? {
                      nativeButtons: true,
                      nativeSelects: true,
                      polls: false,
                      media: true,
                      templates: true,
                      banRisk: false,
                      needsBrowser: false,
                      onboarding: "token"
                  }
                : {
                      nativeButtons: false,
                      nativeSelects: false,
                      polls: true,
                      media: true,
                      templates: false,
                      banRisk: true,
                      needsBrowser: true,
                      onboarding: "qr"
                  };
    }
}
