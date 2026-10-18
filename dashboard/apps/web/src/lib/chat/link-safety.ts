/**
 * Whether the links people post in chat are ones the outside world has flagged.
 *
 * Runs after a message is sent or edited, never before: the send has already
 * answered by the time anything here starts, and nothing here can fail or slow
 * it. Each link is asked about the reputation services the administrator turned
 * on for chat, through the platform's one reputation cache (`lib/reputation`),
 * so a link is bought once however many messages repeat it and however many
 * people read them. What comes back is written per message, flagged links only,
 * for the screen to warn on.
 *
 * Two services, asked the question each can actually answer:
 * - VirusTotal, about the link's host - the same domain lookup the mail filter
 *   makes, under the same cache entry, so a domain mail already asked about is
 *   not bought again for chat.
 * - Dymo, about the page itself - its data verifier's URL verdict, asked
 *   without the query string.
 *
 * Links to this deployment and to hosts inside the network are never sent
 * anywhere (`isOutsideHost`).
 *
 * **Silence is not an accusation**, as in mail: an unconfigured, broken, slow or
 * out-of-budget provider contributes nothing, and an unknown domain is not a
 * suspicious one. A message with no flags is not a message declared safe.
 */

import { z } from "zod";
import { isIP } from "node:net";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import { dashboardHosts } from "@/lib/domain-edge";
import { verifyUrl } from "@/lib/integrations/dymo";
import { lookupDomain } from "@/lib/integrations/virustotal";
import { getSetting, setSetting } from "@/lib/setting-store";
import { knownReputation, rememberReputation, type Verdict } from "@/lib/reputation";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import { resetLookupBudget, takeLookup } from "@/lib/reputation-budget";

export const LINK_SAFETY_PROVIDERS = ["virustotal", "dymo"] as const;
export type LinkSafetyProvider = (typeof LINK_SAFETY_PROVIDERS)[number];

const linkSafetySettingsSchema = z.object({
    enabled: z.boolean(),
    providers: z.array(z.enum(LINK_SAFETY_PROVIDERS)).max(LINK_SAFETY_PROVIDERS.length)
});

export type LinkSafetySettings = z.infer<typeof linkSafetySettingsSchema>;

const SETTING_KEY = "chat.linkSafety";

/**
 * Off until an administrator turns it on, and every provider offered once they
 * do. Off because it sends what people post to a third party, which is a choice
 * somebody makes rather than one an update makes for them.
 */
export const DEFAULT_LINK_SAFETY: LinkSafetySettings = {
    enabled: false,
    providers: [...LINK_SAFETY_PROVIDERS]
};

/** What the administrator chose, or the default when nothing (or nothing
 *  readable) is stored. */
export async function linkSafetySettings(): Promise<LinkSafetySettings> {
    const raw = await getSetting(SETTING_KEY);
    if (!raw) return DEFAULT_LINK_SAFETY;
    try {
        const parsed = linkSafetySettingsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : DEFAULT_LINK_SAFETY;
    } catch {
        return DEFAULT_LINK_SAFETY;
    }
}

/** Store the administrator's choice. The caller checks they are one. */
export async function saveLinkSafetySettings(input: unknown): Promise<LinkSafetySettings> {
    const parsed = linkSafetySettingsSchema.parse(input);
    const settings = { enabled: parsed.enabled, providers: [...new Set(parsed.providers)] };
    await setSetting(SETTING_KEY, JSON.stringify(settings));
    return settings;
}

/** The most links in one message that are checked. Past this it is a list, and
 *  a list of fifty addresses must not cost fifty lookups. */
export const MAX_CHECKED_LINKS = 10;

/** The part of each provider's budget chat may spend. Chat checks after the
 *  send and can go without; the mail filter decides where a message lands, so
 *  the other half is left for it. */
const CHAT_SHARE = 0.5;

/** Forget what was spent. For the tests. */
export function resetLinkSafetyBudget(): void {
    resetLookupBudget();
    inFlight.clear();
}

/** Host endings that only resolve inside somebody's own network. */
const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa"];

/**
 * Whether a link's host is one an outside service may be told about.
 *
 * Not this deployment's own names or anything under them - its share and invite
 * links carry their secret in the address - and not a host that only exists
 * inside the network (loopback, a private range, a bare machine name), which no
 * outside service can know anything about and which says how the network is laid
 * out.
 */
export function isOutsideHost(host: string, ownHosts: readonly string[]): boolean {
    const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (isIP(bare)) return !core.isPrivateIp(bare);
    if (!bare.includes(".") || LOCAL_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return false;
    return !ownHosts.some((own) => bare === own || bare.endsWith(`.${own}`));
}

/** The part of a link Dymo is asked about: the page, without its query, which
 *  is where a signed or one-time address keeps its secret. */
export function lookupAddress(url: string): string {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
}

/** The same question asked twice at once is asked once: two messages posted
 *  together with one link share the lookup. */
const inFlight = new Map<string, Promise<Verdict | null>>();

function once(key: string, work: () => Promise<Verdict | null>): Promise<Verdict | null> {
    const running = inFlight.get(key);
    if (running) return running;
    const started = work().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
}

/** What VirusTotal says about the host, cached under the same entry the mail
 *  filter uses. An unknown domain or a failed lookup is no opinion and is not
 *  written down. */
async function virusTotalOpinion(host: string): Promise<Verdict | null> {
    const known = await knownReputation("domain", host, "virustotal");
    if (known) return known;
    return once(`virustotal:${host}`, async () => {
        const apiKey = await getIntegrationSecret("virustotal");
        if (!apiKey || !takeLookup("virustotal", CHAT_SHARE)) return null;
        const verdict = await lookupDomain(apiKey, host);
        if (verdict.kind === "error" || verdict.kind === "unknown") return null;
        const flagged = verdict.kind === "malicious" || verdict.kind === "suspicious";
        const remembered: Verdict = {
            allow: !flagged,
            reason: flagged
                ? `${verdict.malicious + verdict.suspicious} security engines flag this domain`
                : null
        };
        await rememberReputation("domain", host, "virustotal", remembered);
        return remembered;
    });
}

/** What Dymo says about the page a link is to, cached per page. */
async function dymoOpinion(link: string): Promise<Verdict | null> {
    const url = lookupAddress(link);
    const known = await knownReputation("url", url, "dymo");
    if (known) return known;
    return once(`dymo:${url}`, async () => {
        const apiKey = await getIntegrationSecret("dymo");
        if (!apiKey || !takeLookup("dymo", CHAT_SHARE)) return null;
        try {
            const { fraud } = await verifyUrl(apiKey, url);
            const remembered: Verdict = {
                allow: !fraud,
                reason: fraud ? "This link is known for fraud" : null
            };
            await rememberReputation("url", url, "dymo", remembered);
            return remembered;
        } catch {
            return null;
        }
    });
}

export interface FlaggedLink {
    /** The link as `core.normalizeLink` writes it. */
    readonly url: string;
    readonly provider: LinkSafetyProvider;
    readonly reason: string | null;
}

/**
 * The providers that will be asked: chosen for chat by the administrator, and
 * switched on with a key in Integrations. Asked in that order so turning a
 * provider off stops it counting at once, and so the usual case - nothing on -
 * is one settings read.
 */
async function activeProviders(): Promise<LinkSafetyProvider[]> {
    const settings = await linkSafetySettings();
    if (!settings.enabled) return [];
    const active: LinkSafetyProvider[] = [];
    for (const provider of settings.providers) {
        const state = await getIntegrationState(provider);
        if (state?.enabled) active.push(provider);
    }
    return active;
}

/** Ask every active provider about one link. The first that flags it is the
 *  answer; the rest are not asked, since one flag is all the screen needs. */
async function judge(
    url: string,
    providers: readonly LinkSafetyProvider[]
): Promise<FlaggedLink | null> {
    const host = new URL(url).hostname;
    for (const provider of providers) {
        const verdict =
            provider === "virustotal" ? await virusTotalOpinion(host) : await dymoOpinion(url);
        if (verdict && !verdict.allow) return { url, provider, reason: verdict.reason };
    }
    return null;
}

/**
 * Check the links in one message and write down the flagged ones.
 *
 * Replaces whatever was written for the message before, so an edit that removes
 * a bad link takes its warning with it. The body is read again before writing:
 * when the message was edited while this was asking, the newer check owns the
 * result and this one leaves it alone.
 */
export async function checkMessageLinks(messageId: string): Promise<void> {
    const providers = await activeProviders();
    if (providers.length === 0) return;

    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, body: true, deletedAt: true }
    });
    if (!message || message.deletedAt) return;

    const candidates = [
        ...new Set(
            core
                .linksIn(message.body, MAX_CHECKED_LINKS)
                .map((link) => core.normalizeLink(link))
                .filter((link): link is string => link !== null)
        )
    ];
    const ownHosts = candidates.length > 0 ? await dashboardHosts() : [];
    const links = candidates.filter((link) => isOutsideHost(new URL(link).hostname, ownHosts));

    const flagged: FlaggedLink[] = [];
    for (const url of links) {
        const flag = await judge(url, providers);
        if (flag) flagged.push(flag);
    }

    const current = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { body: true }
    });
    if (!current || current.body !== message.body) return;

    const [cleared] = await prisma.$transaction([
        prisma.chatMessageLinkFlag.deleteMany({ where: { messageId } }),
        ...(flagged.length
            ? [
                  prisma.chatMessageLinkFlag.createMany({
                      data: flagged.map((flag) => ({ messageId, ...flag })),
                      skipDuplicates: true
                  })
              ]
            : [])
    ]);

    // The check finishes after the screen drew the message, so a warning that
    // appeared - or went away with an edit - is pushed rather than waiting for
    // the next reload. Nothing is sent when nothing was or is flagged, which is
    // nearly always.
    if (flagged.length > 0 || cleared.count > 0) {
        publishChatChange({
            channelId: message.channelId,
            kind: "posted",
            actorId: "",
            messageIds: [messageId]
        });
    }
}

/** Check a message's links in the background. Never awaited by a send, and
 *  never allowed to fail one. */
export function checkLinksLater(messageId: string): void {
    void checkMessageLinks(messageId).catch((error: unknown) => {
        console.warn("chat link check failed", error instanceof Error ? error.message : error);
    });
}

/**
 * The flagged links of a page of messages, in one query. Messages with none are
 * absent from the map.
 *
 * Only what the providers active right now said: turning link safety off, or a
 * provider off, takes its warnings off every message at once rather than leaving
 * the ones already written to be read under a switch that says otherwise.
 */
export async function flaggedLinksFor(
    messageIds: readonly string[]
): Promise<Map<string, FlaggedLink[]>> {
    const byMessage = new Map<string, FlaggedLink[]>();
    if (messageIds.length === 0) return byMessage;
    const providers = await activeProviders();
    if (providers.length === 0) return byMessage;
    const rows = await prisma.chatMessageLinkFlag.findMany({
        where: { messageId: { in: [...messageIds] }, provider: { in: providers } },
        select: { messageId: true, url: true, provider: true, reason: true }
    });
    for (const row of rows) {
        const list = byMessage.get(row.messageId) ?? [];
        list.push({
            url: row.url,
            provider: row.provider as LinkSafetyProvider,
            reason: row.reason
        });
        byMessage.set(row.messageId, list);
    }
    return byMessage;
}

/** One provider as the settings screen draws it. */
export interface LinkSafetyProviderState {
    readonly provider: LinkSafetyProvider;
    /** Chosen for chat by the administrator. */
    readonly chosen: boolean;
    /** Switched on with a key in Integrations, without which choosing it does
     *  nothing. */
    readonly configured: boolean;
}

/** The setting and, per provider, whether it can actually answer. */
export async function linkSafetyOverview(): Promise<{
    enabled: boolean;
    providers: LinkSafetyProviderState[];
}> {
    const settings = await linkSafetySettings();
    const providers = await Promise.all(
        LINK_SAFETY_PROVIDERS.map(async (provider) => {
            const state = await getIntegrationState(provider);
            return {
                provider,
                chosen: settings.providers.includes(provider),
                configured: Boolean(state?.enabled && state.hasSecret)
            };
        })
    );
    return { enabled: settings.enabled, providers };
}
