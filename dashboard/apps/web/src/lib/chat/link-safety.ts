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
 * - Dymo, about the link itself - its data verifier's URL verdict.
 *
 * **Silence is not an accusation**, as in mail: an unconfigured, broken, slow or
 * out-of-budget provider contributes nothing, and an unknown domain is not a
 * suspicious one. A message with no flags is not a message declared safe.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import { verifyUrl } from "@/lib/integrations/dymo";
import { lookupDomain } from "@/lib/integrations/virustotal";
import { getSetting, setSetting } from "@/lib/setting-store";
import { knownReputation, rememberReputation, type Verdict } from "@/lib/reputation";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

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

/**
 * How many lookups each provider may be sent from this process.
 *
 * VirusTotal's figures are its free Public API's: four a minute and 500 a day.
 * A paid key allows more and simply never meets them. Dymo's quota depends on
 * the plan and is not something Polaris can read, so its ceiling here is
 * Polaris's own guard against one busy channel spending the month's quota in an
 * afternoon, not the provider's limit. Past either, a link goes unchecked rather
 * than waiting: the cache keeps the answers already bought, and the next message
 * with that link asks again.
 */
const BUDGET: Readonly<Record<LinkSafetyProvider, { perMinute: number; perDay: number }>> = {
    virustotal: { perMinute: 4, perDay: 500 },
    dymo: { perMinute: 30, perDay: 2000 }
};

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** When each lookup in the last day was sent, per provider. In memory: one
 *  process is one deployment's dashboard, and a restart forgetting a day's count
 *  costs at most one day's budget again. */
const spent = new Map<LinkSafetyProvider, number[]>();

/** Take one lookup from the provider's budget, or answer false when there is
 *  none left in this minute or this day. */
function takeBudget(provider: LinkSafetyProvider, now = Date.now()): boolean {
    const times = (spent.get(provider) ?? []).filter((at) => now - at < DAY_MS);
    const lastMinute = times.filter((at) => now - at < MINUTE_MS).length;
    const limit = BUDGET[provider];
    if (times.length >= limit.perDay || lastMinute >= limit.perMinute) {
        spent.set(provider, times);
        return false;
    }
    times.push(now);
    spent.set(provider, times);
    return true;
}

/** Forget what was spent. For the tests. */
export function resetLinkSafetyBudget(): void {
    spent.clear();
    inFlight.clear();
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
        if (!apiKey || !takeBudget("virustotal")) return null;
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

/** What Dymo says about the link itself, cached per link. */
async function dymoOpinion(url: string): Promise<Verdict | null> {
    const known = await knownReputation("url", url, "dymo");
    if (known) return known;
    return once(`dymo:${url}`, async () => {
        const apiKey = await getIntegrationSecret("dymo");
        if (!apiKey || !takeBudget("dymo")) return null;
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

    const links = [
        ...new Set(
            core
                .linksIn(message.body, MAX_CHECKED_LINKS)
                .map((link) => core.normalizeLink(link))
                .filter((link): link is string => link !== null)
        )
    ];

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
 */
export async function flaggedLinksFor(
    messageIds: readonly string[]
): Promise<Map<string, FlaggedLink[]>> {
    const byMessage = new Map<string, FlaggedLink[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = await prisma.chatMessageLinkFlag.findMany({
        where: { messageId: { in: [...messageIds] } },
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
