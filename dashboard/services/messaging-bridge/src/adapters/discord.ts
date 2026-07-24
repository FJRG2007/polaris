/**
 * Discord adapter via discord.js over the gateway. Receives messages and button
 * clicks live, and sends text or native buttons (chunked into action rows). No
 * browser, free. Inbound flows through the bridge to the web ingest like Telegram.
 */

import {
    ButtonStyle,
    ChannelType,
    Client,
    ComponentType,
    GatewayIntentBits,
    Partials,
    type APIActionRowComponent,
    type APIMessageActionRowComponent,
    type Message
} from "discord.js";
import { capabilitiesFor } from "@polaris/messaging";
import type {
    AdapterContext,
    ChannelAdapter,
    InteractivePrompt,
    OutboundMessage,
    SendResult,
    TargetGroup
} from "@polaris/messaging";

/** Discord allows at most 5 buttons per row and 5 rows. */
const MAX_BUTTONS = 25;
const BUTTONS_PER_ROW = 5;

// Message Content and Server Members are independent privileged intents, each
// toggled in the Discord Developer Portal (Bot > Privileged Gateway Intents).
// Discord rejects the whole login (code 4014, "Disallowed intents") if ANY
// requested privileged intent is off, so we cannot request both and expect a
// partial grant. Instead we try progressively less-privileged tiers, stopping at
// the first that connects:
//   FULL     - both on: server-channel text + DM by username.
//   CONTENT  - Server Members off: server-channel text works, DM by username does not.
//   REDUCED  - Message Content also off: server-channel text is empty.
const FULL_INTENTS = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
];
const CONTENT_INTENTS = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
];
const REDUCED_INTENTS = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
];

// Ordered most- to least-privileged. `note` describes what is degraded at a tier
// and is logged when we fall back to it (the full tier has nothing degraded).
const INTENT_TIERS: { intents: GatewayIntentBits[]; note?: string }[] = [
    { intents: FULL_INTENTS },
    {
        intents: CONTENT_INTENTS,
        note: "Discord: the Server Members intent is disabled in the Developer Portal, connecting without it - DM by username is disabled (use the numeric User ID); server-channel message text still works. Enable it under Bot > Privileged Gateway Intents."
    },
    {
        intents: REDUCED_INTENTS,
        note: "Discord: the Message Content intent is disabled in the Developer Portal, connecting with reduced intents - message text in server channels will be empty until you enable it (Bot > Privileged Gateway Intents)."
    }
];

export class DiscordAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("discord");
    private readonly token: string;
    private readonly channelId: string;
    private readonly ctx: AdapterContext;
    private client: Client;

    constructor(token: string, channelId: string, ctx: AdapterContext) {
        this.token = token;
        this.channelId = channelId;
        this.ctx = ctx;
        this.client = this.build(FULL_INTENTS);
    }

    /** Build a client with the given intents and wire its handlers. */
    private build(intents: GatewayIntentBits[]): Client {
        const client = new Client({ intents, partials: [Partials.Channel, Partials.Message] });
        this.wire(client);
        return client;
    }

    private wire(client: Client): void {
        client.on("messageCreate", (message: Message) => {
            if (message.author.bot) return;
            this.ctx.onInbound({
                channelId: this.channelId,
                peerId: message.guild ? message.channelId : `user:${message.author.id}`,
                peerName: message.author.username,
                externalId: message.id,
                kind: "text",
                body: message.content,
                at: Date.now()
            });
        });
        client.on("interactionCreate", (interaction) => {
            if (!interaction.isButton()) return;
            void interaction.deferUpdate().catch(() => undefined);
            this.ctx.onInbound({
                channelId: this.channelId,
                peerId: interaction.guildId
                    ? (interaction.channelId ?? "")
                    : `user:${interaction.user.id}`,
                peerName: interaction.user.username,
                kind: "interactive",
                selection: interaction.customId,
                at: Date.now()
            });
        });
    }

    private async login(): Promise<{ externalId?: string }> {
        const ready = new Promise<void>((resolve) => this.client.once("ready", () => resolve()));
        await this.client.login(this.token);
        await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, 8000))]);
        return { externalId: this.client.user?.tag };
    }

    async connect(): Promise<{ externalId?: string }> {
        let lastError: unknown = new Error("Could not connect to Discord");
        // Try each intent tier in order. The constructor already built the client on
        // the first (full) tier, so we only rebuild when falling back. A disallowed
        // privileged intent means one of the requested toggles is off in the portal:
        // destroy the client and retry the next, less-privileged tier.
        for (let tier = 0; tier < INTENT_TIERS.length; tier++) {
            const { intents, note } = INTENT_TIERS[tier];
            if (tier > 0) {
                await this.client.destroy().catch(() => undefined);
                this.client = this.build(intents);
                if (note) this.ctx.log(note);
            }
            try {
                return await this.login();
            } catch (caught) {
                lastError = caught;
                const detail = caught instanceof Error ? caught.message : String(caught);
                if (/disallowed intents|privileged intent/i.test(detail)) continue;
                if (/token|unauthorized|invalid/i.test(detail)) {
                    throw new Error(
                        "Discord rejected the bot token. Check it in the Developer Portal (Bot > Token)."
                    );
                }
                throw caught instanceof Error ? caught : new Error("Could not connect to Discord");
            }
        }
        throw lastError instanceof Error ? lastError : new Error("Could not connect to Discord");
    }

    async disconnect(): Promise<void> {
        await this.client.destroy();
    }

    private buttonRows(
        prompt: InteractivePrompt
    ): APIActionRowComponent<APIMessageActionRowComponent>[] {
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

    /** Resolve a Discord recipient. `user:<id>` is a direct message to that user;
     *  `channel:<id>` or a bare id is a server text channel (bare kept for
     *  back-compat with handles stored before the DM/channel split). */
    private resolvePeer(peerId: string): { dm: boolean; id: string } {
        if (peerId.startsWith("user:")) return { dm: true, id: peerId.slice("user:".length) };
        if (peerId.startsWith("channel:"))
            return { dm: false, id: peerId.slice("channel:".length) };
        return { dm: false, id: peerId };
    }

    /** Resolve a DM recipient to a user snowflake. A numeric id is used directly; a
     *  username (or @username) is looked up across the bot's servers by member
     *  search, which needs the Server Members privileged intent and a shared server. */
    private async resolveUserId(idOrName: string): Promise<string> {
        if (/^\d{17,}$/.test(idOrName)) return idOrName;
        const name = idOrName.replace(/^@/, "").trim().toLowerCase();
        if (!name) throw new Error("Enter a Discord user id or username to DM");
        for (const guild of this.client.guilds.cache.values()) {
            try {
                const members = await guild.members.fetch({ query: name, limit: 5 });
                const match = members.find(
                    (member) =>
                        member.user.username.toLowerCase() === name ||
                        member.user.globalName?.toLowerCase() === name ||
                        member.displayName.toLowerCase() === name
                );
                if (match) return match.id;
            } catch {
                // Members intent off or no access in this guild; try the next one.
            }
        }
        throw new Error(
            `Could not find a Discord user "${idOrName}". Enable the Server Members intent (Bot > Privileged Gateway Intents), make sure the bot shares a server with them, or use their numeric User ID.`
        );
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const { dm, id } = this.resolvePeer(message.peerId);
        // For a DM, open (or reuse) the user's DM channel; otherwise fetch the server
        // channel. Both end up as a text-based channel we can post to.
        const channel = dm
            ? await (await this.client.users.fetch(await this.resolveUserId(id))).createDM()
            : await this.client.channels.fetch(id);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
            throw new Error(
                dm
                    ? "Could not open a DM with that user"
                    : "The Discord channel is not a text channel"
            );
        }
        const payload = message.interactive
            ? {
                  content: message.interactive.text,
                  components: this.buttonRows(message.interactive)
              }
            : { content: message.text ?? "" };
        const sent = await channel.send(payload);
        return { externalId: sent.id };
    }

    /** The bot's servers and the text channels it can post to, for the recipient
     *  picker. Read from the gateway cache (populated on ready by the Guilds intent),
     *  so it needs no extra permission beyond being in the server. */
    async listTargets(): Promise<TargetGroup[]> {
        const groups: TargetGroup[] = [];
        for (const guild of this.client.guilds.cache.values()) {
            const channels = [...guild.channels.cache.values()]
                .filter(
                    (channel) =>
                        channel.type === ChannelType.GuildText ||
                        channel.type === ChannelType.GuildAnnouncement
                )
                .map((channel) => ({ id: channel.id, name: `#${channel.name}` }))
                .sort((a, b) => a.name.localeCompare(b.name));
            if (channels.length > 0)
                groups.push({ id: guild.id, name: guild.name, targets: channels });
        }
        return groups.sort((a, b) => a.name.localeCompare(b.name));
    }
}
