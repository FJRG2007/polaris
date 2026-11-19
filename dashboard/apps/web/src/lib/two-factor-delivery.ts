/**
 * Getting a second-factor code to the person signing in, and deciding which ways
 * are open to them at all.
 *
 * A method is only offered when three separate things hold: the account turned it
 * on, the owner proved the address or number it goes to, and the deployment has
 * something to send with. All three are resolved here, in one place, so the
 * settings page and the challenge screen can never disagree about what works -
 * and so a method whose channel was deleted stops being offered immediately
 * rather than failing at the moment somebody is locked out.
 *
 * The authenticator is not part of that: it needs nothing from the deployment,
 * which is exactly why it stays the method that cannot be turned off.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { normalizePeerId } from "@/lib/messaging-service";
import { sendCodeThroughChannel } from "@/lib/messaging/channel-runtime";
import { codeRouteFor } from "@/lib/messaging/code-senders";
import { telegramChatFor } from "@/lib/messaging/telegram-link";
import { getAuthMailStatus, sendAuthEmail } from "@/lib/auth-mail";
import { getUserPhone, getUserSecurity, noteSecondFactor, twoFactorEnabled } from "@polaris/auth";
import {
    maskEmail,
    maskPhone,
    SECOND_FACTOR_BY_DELIVERY,
    TWO_FACTOR_CODE_TTL_MINUTES,
    TWO_FACTOR_DELIVERY_METHODS,
    TWO_FACTOR_METHODS,
    type TwoFactorDeliveryMethod,
    type TwoFactorMethod
} from "@polaris/core";
import { readerWords } from "@/lib/i18n/reader-words";
import { acceptedMethods } from "@/lib/two-factor-policy";
import { loadTwoFactorPolicy } from "@/lib/two-factor-policy-store";

/** How many codes one account may ask for, and over what span. Loose enough for
 *  a message that never arrived, tight enough that the mailbox is not a target. */
const SEND_LIMIT = 5;
const SEND_WINDOW_MS = 15 * 60 * 1000;

/** What one method can do for one account right now. */
export interface TwoFactorMethodStatus {
    method: TwoFactorMethod;
    /** The account has turned it on. Always true for the authenticator. */
    enabled: boolean;
    /** It could deliver a code right now. */
    available: boolean;
    /** Where the code would go, masked. Null when there is nowhere yet. */
    target: string | null;
    /** Why it cannot be used, for the settings page. Null when it can. */
    blocker: string | null;
}

/** Where a code would go for one method, and what stops it if nothing can. */
interface Destination {
    /** The address or number, unmasked - only ever used to send. */
    address: string;
    /** For WhatsApp and Telegram, the channel that carries it. */
    channelId?: string;
}

interface Resolution {
    destination: Destination | null;
    blocker: string | null;
}

/** The address a code goes to: the sign-in address once proved, else the first
 *  alternate the owner proved. An unproved address is not a factor - anyone could
 *  have typed it in. */
async function emailDestination(userId: string): Promise<Resolution> {
    const [user, alternate, mail] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
        prisma.userEmail.findFirst({
            where: { userId, verifiedAt: { not: null } },
            orderBy: { createdAt: "asc" },
            select: { email: true }
        }),
        getAuthMailStatus()
    ]);
    const address = user?.emailVerified ? user.email : alternate?.email;
    if (!address) return { destination: null, blocker: "No confirmed address on your account." };
    if (!mail.channelId) return { destination: null, blocker: "Polaris has no email channel to send from." };
    return { destination: { address }, blocker: null };
}

/**
 * Where a WhatsApp code goes: the person's confirmed number, through the sender
 * an administrator picked under Integrations > Messaging - or, on an install that
 * predates it, through a WhatsApp channel the person connected themselves
 * (lib/messaging/code-route.ts).
 */
async function whatsappDestination(userId: string): Promise<Resolution> {
    const [phone, route] = await Promise.all([getUserPhone(userId), codeRouteFor("whatsapp", userId)]);
    if (!phone?.verified) return { destination: null, blocker: "Confirm a phone number on your profile first." };
    if (route.channelId === null) return { destination: null, blocker: route.blocker };
    return { destination: { address: phone.phone, channelId: route.channelId }, blocker: null };
}

/** Where a Telegram code goes: the chat the person linked by pressing Start. */
async function telegramDestination(userId: string): Promise<Resolution> {
    const [chatId, route] = await Promise.all([telegramChatFor(userId), codeRouteFor("telegram", userId)]);
    if (route.channelId === null) return { destination: null, blocker: route.blocker };
    if (!chatId) return { destination: null, blocker: "Link your Telegram account first." };
    return { destination: { address: chatId, channelId: route.channelId }, blocker: null };
}

function resolveDestination(userId: string, method: TwoFactorDeliveryMethod): Promise<Resolution> {
    if (method === "email") return emailDestination(userId);
    return method === "telegram" ? telegramDestination(userId) : whatsappDestination(userId);
}

function maskDestination(method: TwoFactorDeliveryMethod, address: string): string {
    if (method === "email") return maskEmail(address);
    // A chat id is not something the person recognises, and not worth showing.
    return method === "telegram" ? "Telegram" : maskPhone(address);
}

/**
 * Every method with what it can do for this account, including the ones that are
 * off or broken - the settings page has to show why, and hiding a method the
 * owner deliberately turned on would just look like it was forgotten.
 */
export async function describeTwoFactorMethods(userId: string): Promise<TwoFactorMethodStatus[]> {
    const [settings, hasAuthenticator] = await Promise.all([
        getUserSecurity(userId),
        twoFactorEnabled(userId)
    ]);
    const resolutions = await Promise.all(
        TWO_FACTOR_DELIVERY_METHODS.map((method) => resolveDestination(userId, method))
    );
    // An account that met the instance's requirement with an email code has the
    // factor on and no authenticator behind it - better-auth minted the secret and
    // nobody was ever shown it. Offering it here would put a code field in front of
    // somebody with no app to read one from, on the screen they are trying to sign
    // in with.
    const claimed = hasAuthenticator && !settings.totpUnclaimed;
    const authenticator: TwoFactorMethodStatus = {
        method: "totp",
        enabled: true,
        available: claimed,
        target: null,
        blocker: hasAuthenticator
            ? settings.totpUnclaimed
                ? "No authenticator is set up on this account."
                : null
            : "Two-step verification is off."
    };
    const delivery = TWO_FACTOR_DELIVERY_METHODS.map((method, index) => {
        const { destination, blocker } = resolutions[index] ?? { destination: null, blocker: null };
        return {
            method,
            enabled: settings.twoFactorMethods.includes(method),
            available: destination !== null,
            target: destination ? maskDestination(method, destination.address) : null,
            blocker
        };
    });
    // Ordered by the catalogue rather than by how they were resolved, so every
    // surface lists them the same way.
    const byMethod = new Map<TwoFactorMethod, TwoFactorMethodStatus>(
        [authenticator, ...delivery].map((status) => [status.method, status])
    );
    return TWO_FACTOR_METHODS.map((method) => byMethod.get(method)).filter(
        (status): status is TwoFactorMethodStatus => status !== undefined
    );
}

/** One way in, as the challenge screen lists it. The label and the explanation
 *  come from the shared catalogue, so only what varies per account travels. */
export interface ChallengeMethod {
    method: TwoFactorMethod;
    /** Masked address or number, for the methods that send somewhere. */
    target: string | null;
}

/** What the challenge screen offers, and which entry it starts on. */
export interface ChallengeOptions {
    methods: ChallengeMethod[];
    preferred: TwoFactorMethod | null;
}

/**
 * The ways this account can finish signing in right now: the authenticator, plus
 * every method it turned on that can actually deliver. The preference decides
 * where the screen starts, and falls back to the first way still open when the
 * preferred one is not among them.
 */
export async function challengeOptions(userId: string): Promise<ChallengeOptions> {
    const [settings, statuses, policy] = await Promise.all([
        getUserSecurity(userId),
        describeTwoFactorMethods(userId),
        loadTwoFactorPolicy(userId)
    ]);
    // Only the methods the account accepts as its second factor - which falls
    // back to every one set up when the refusals would leave none.
    const usable = statuses.filter((status) => status.enabled && status.available);
    const accepted = acceptedMethods(
        usable.map((status) => status.method),
        policy.refused
    );
    const methods = usable
        .filter((status) => accepted.includes(status.method))
        .map((status) => ({ method: status.method, target: status.target }));
    const preferred = methods.some((entry) => entry.method === settings.twoFactorPreferred)
        ? settings.twoFactorPreferred
        : (methods[0]?.method ?? null);
    return { methods, preferred };
}

/** One message, in both forms, whichever channel ends up carrying it. */
export interface CodeMessage {
    subject: string;
    text: string;
    html: string;
}

/**
 * Put a message in front of an account by one of its delivery methods.
 *
 * The address is resolved here rather than passed in, so nothing outside this
 * module ever holds an unmasked address, and a method whose channel has since
 * gone says so instead of failing somewhere quieter. Used by the sign-in
 * challenge below and by the mid-session confirmations, which need the same
 * three questions answered - is the method on, can it deliver, where to - and
 * must not answer them a second, slightly different way.
 */
export async function deliverCode(
    userId: string,
    method: TwoFactorDeliveryMethod,
    message: CodeMessage & { code?: string }
): Promise<{ error?: string }> {
    const { destination, blocker } = await resolveDestination(userId, method);
    if (!destination) return { error: blocker ?? (await readerWords("api"))("refusals.twoFactor.methodUnusable") };
    return method === "email"
        ? sendAuthEmail({ to: destination.address, subject: message.subject, text: message.text, html: message.html })
        : sendByChannel(method, destination, message.text, message.code);
}

function messageBody(code: string): { text: string; html: string } {
    const text = [
        `Your Polaris sign-in code is ${code}.`,
        "",
        `It expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes and works once.`,
        "If you did not try to sign in, change your password - somebody else knows it."
    ].join("\n");
    const html = [
        `<p>Your Polaris sign-in code is <strong>${code}</strong>.</p>`,
        `<p>It expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes and works once.</p>`,
        "<p>If you did not try to sign in, change your password - somebody else knows it.</p>"
    ].join("");
    return { text, html };
}

/**
 * Send one second-factor code.
 *
 * The method the challenge screen asked for is a hint and nothing more: it is
 * honoured only when the account has that method turned on and it can deliver,
 * and otherwise the account's own preference decides. That is what keeps a
 * forged header from doing anything - the worst it can do is pick between the
 * ways into an account that its owner already opened.
 *
 * Returns why the code could not go rather than throwing. Nothing surfaces the
 * reason to the caller of the endpoint; it is recorded so an operator can see it.
 */
export async function sendTwoFactorCode(input: {
    userId: string;
    requested: string | null;
    code: string;
}): Promise<{ error?: string }> {
    const { userId, code } = input;
    const throttle = await rateLimit(`2fa-code:${userId}`, SEND_LIMIT, SEND_WINDOW_MS);
    if (!throttle.ok) return { error: (await readerWords("api"))("refusals.twoFactor.tooManyCodes") };

    const [settings, statuses, policy] = await Promise.all([
        getUserSecurity(userId),
        describeTwoFactorMethods(userId),
        loadTwoFactorPolicy(userId)
    ]);
    const setUp = statuses.filter((status) => status.enabled && status.available);
    const accepted = acceptedMethods(
        setUp.map((status) => status.method),
        policy.refused
    );
    const usable = setUp.filter((status) => status.method !== "totp" && accepted.includes(status.method));
    const asked = usable.find((status) => status.method === input.requested);
    const preferred = usable.find((status) => status.method === settings.twoFactorPreferred);
    const chosen = (asked ?? preferred ?? usable[0])?.method;
    if (chosen === undefined || chosen === "totp") {
        return { error: (await readerWords("api"))("refusals.twoFactor.noWay") };
    }

    const { destination } = await resolveDestination(userId, chosen);
    // Re-resolved rather than carried over from the status above, so the send
    // uses the real address instead of the masked one shown on screen.
    if (!destination) return { error: (await readerWords("api"))("refusals.twoFactor.methodUnusable") };

    const { text, html } = messageBody(code);
    const result =
        chosen === "email"
            ? await sendAuthEmail({ to: destination.address, subject: "Your Polaris sign-in code", text, html })
            : await sendByChannel(chosen, destination, text, code);

    // Which channel carried the code is only known here - the request that checks
    // it carries nothing about where it came from - so a code that actually went
    // out leaves its channel against the sign-in in progress.
    if (!result.error) await noteSecondFactor(userId, SECOND_FACTOR_BY_DELIVERY[chosen] ?? "code");

    await recordAudit({
        actorId: userId,
        action: result.error ? "account.2fa.code-failed" : "account.2fa.code-sent",
        metadata: { method: chosen }
    });
    return result;
}

/**
 * Hand the message straight to the channel, so it is never written into any
 * history: a code that outlives the minute it was good for is a code sitting in
 * a database for no reason. With the code known, a WhatsApp Business API sender
 * uses its approved authentication template, the only way it may open a chat.
 */
async function sendByChannel(
    platform: "whatsapp" | "telegram",
    destination: Destination,
    text: string,
    code?: string
): Promise<{ error?: string }> {
    if (!destination.channelId) return { error: (await readerWords("api"))("refusals.twoFactor.noWhatsApp") };
    try {
        await sendCodeThroughChannel(destination.channelId, {
            peerId: normalizePeerId(platform, destination.address),
            code: code ?? "",
            text
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : (await readerWords("api"))("refusals.twoFactor.channelRefused") };
    }
}
