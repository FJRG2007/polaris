/**
 * Discord adapter via discord.js over the gateway. Receives messages and button
 * clicks live, and sends text or native buttons (chunked into action rows). No
 * browser, free. Inbound flows through the bridge to the web ingest like Telegram.
 */

import {
    ButtonStyle,
    Client,
    ComponentType,
    GatewayIntentBits,
    type APIActionRowComponent,
    type APIMessageActionRowComponent,
    type Message
} from "discord.js";
import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, InteractivePrompt, OutboundMessage, SendResult } from "@polaris/messaging";

/** Discord allows at most 5 buttons per row and 5 rows. */
const MAX_BUTTONS = 25;
const BUTTONS_PER_ROW = 5;

export class DiscordAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("discord");
    private readonly token: string;
    private readonly channelId: string;
    private readonly ctx: AdapterContext;
    private readonly client: Client;

    constructor(token: string, channelId: string, ctx: AdapterContext) {
        this.token = token;
        this.channelId = channelId;
        this.ctx = ctx;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ]
        });
        this.wire();
    }

    private wire(): void {
        this.client.on("messageCreate", (message: Message) => {
            if (message.author.bot) return;
            this.ctx.onInbound({
                channelId: this.channelId,
                peerId: message.channelId,
                peerName: message.author.username,
                externalId: message.id,
                kind: "text",
                body: message.content,
                at: Date.now()
            });
        });
        this.client.on("interactionCreate", (interaction) => {
            if (!interaction.isButton()) return;
            void interaction.deferUpdate().catch(() => undefined);
            this.ctx.onInbound({
                channelId: this.channelId,
                peerId: interaction.channelId ?? "",
                peerName: interaction.user.username,
                kind: "interactive",
                selection: interaction.customId,
                at: Date.now()
            });
        });
    }

    async connect(): Promise<{ externalId?: string }> {
        const ready = new Promise<void>((resolve) => this.client.once("ready", () => resolve()));
        await this.client.login(this.token);
        await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, 8000))]);
        return { externalId: this.client.user?.tag };
    }

    async disconnect(): Promise<void> {
        await this.client.destroy();
    }

    private buttonRows(prompt: InteractivePrompt): APIActionRowComponent<APIMessageActionRowComponent>[] {
        const rows: APIActionRowComponent<APIMessageActionRowComponent>[] = [];
        const options = prompt.options.slice(0, MAX_BUTTONS);
        for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
            rows.push({
                type: ComponentType.ActionRow,
                components: options.slice(i, i + BUTTONS_PER_ROW).map((option) => ({
                    type: ComponentType.Button,
                    style: ButtonStyle.Secondary,
                    custom_id: option.id,
                    label: option.label.slice(0, 80)
                }))
            });
        }
        return rows;
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const channel = await this.client.channels.fetch(message.peerId);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
            throw new Error("The Discord channel is not a text channel");
        }
        const sent = message.interactive
            ? await channel.send({
                  content: message.interactive.text,
                  components: this.buttonRows(message.interactive)
              })
            : await channel.send({ content: message.text ?? "" });
        return { externalId: sent.id };
    }
}
