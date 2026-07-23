/**
 * Zod schemas for the bridge HTTP API and the inbound-event callback. Shared by
 * the bridge (which validates requests) and the web (which validates the bridge's
 * responses and inbound events - all treated as untrusted).
 */

import { z } from "zod";

export const PLATFORMS = ["telegram", "whatsapp", "discord", "slack"] as const;
export const MESSAGE_KINDS = ["text", "image", "file", "audio", "interactive", "system"] as const;

/** Bring a channel online in the bridge. */
export const connectChannelSchema = z.object({
    channelId: z.string().uuid(),
    platform: z.enum(PLATFORMS),
    /** Provider backend, e.g. WhatsApp: whatsapp-web | whatsapp-cloud. */
    provider: z.string().trim().min(1).max(64).optional(),
    /** Bot token / credential the adapter authenticates with. */
    token: z.string().trim().min(1).max(8192),
    /** Provider-specific non-secret config, e.g. WhatsApp Cloud phoneNumberId. */
    config: z.record(z.string(), z.string().max(256)).optional()
});

export const interactiveOptionSchema = z.object({
    id: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(256)
});

export const interactivePromptSchema = z.object({
    text: z.string().trim().min(1).max(4096),
    options: z.array(interactiveOptionSchema).min(1).max(24),
    style: z.enum(["buttons", "poll"]).optional()
});

/** Send a message on a connected channel. */
export const sendMessageSchema = z
    .object({
        peerId: z.string().trim().min(1).max(256),
        text: z.string().max(8192).optional(),
        interactive: interactivePromptSchema.optional()
    })
    .refine((value) => Boolean(value.text) || Boolean(value.interactive), {
        message: "A message needs text or an interactive prompt"
    });

/** A normalized inbound event the bridge posts to the web's ingest route. */
export const inboundEventSchema = z.object({
    channelId: z.string().uuid(),
    peerId: z.string().min(1),
    peerName: z.string().optional(),
    externalId: z.string().optional(),
    kind: z.enum(MESSAGE_KINDS),
    body: z.string().optional(),
    selection: z.string().optional(),
    at: z.number().int().nonnegative()
});

export type ConnectChannelRequest = z.infer<typeof connectChannelSchema>;
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;
export type InboundEvent = z.infer<typeof inboundEventSchema>;
