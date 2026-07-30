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

import {
    maskEmail,
    maskPhone,
    TWO_FACTOR_CODE_TTL_MINUTES,
    TWO_FACTOR_DELIVERY_METHODS,
    TWO_FACTOR_METHODS,
    type TwoFactorDeliveryMethod,
    type TwoFactorMethod
} from "@polaris/core";
import { getUserPhone, getUserSecurity, twoFactorEnabled } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { getAuthMailStatus, sendAuthEmail } from "@/lib/auth-mail";
import { bridgeSend } from "@/lib/messaging/bridge-client";
import { normalizePeerId } from "@/lib/messaging-service";
import { rateLimit } from "@/lib/rate-limit-service";

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
    /** For WhatsApp, the channel that carries it. */
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
 * Where a WhatsApp code goes. The channel has to be one of the user's own:
 * routing it through somebody else's would drop the conversation, and the code
 * in it, into that person's inbox.
 */
async function whatsappDestination(userId: string): Promise<Resolution> {
    const [phone, channel] = await Promise.all([
        getUserPhone(userId),
        prisma.channel.findFirst({
            where: { ownerId: userId, platform: "whatsapp", status: "connected" },
            orderBy: { createdAt: "asc" },
            select: { id: true }
        })
    ]);
    if (!phone?.verified) return { destination: null, blocker: "Confirm a phone number on your profile first." };
    if (!channel) return { destination: null, blocker: "None of your WhatsApp channels is connected." };
    return { destination: { address: phone.phone, channelId: channel.id }, blocker: null };
}

function resolveDestination(userId: string, method: TwoFactorDeliveryMethod): Promise<Resolution> {
    return method === "email" ? emailDestination(userId) : whatsappDestination(userId);
}

function maskDestination(method: TwoFactorDeliveryMethod, address: string): string {
    return method === "email" ? maskEmail(address) : maskPhone(address);
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
    const authenticator: TwoFactorMethodStatus = {
        method: "totp",
        enabled: true,
        available: hasAuthenticator,
        target: null,
        blocker: hasAuthenticator ? null : "Two-step verification is off."
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
    const [settings, statuses] = await Promise.all([
        getUserSecurity(userId),
        describeTwoFactorMethods(userId)
    ]);
    const methods = statuses
        .filter((status) => status.enabled && status.available)
        .map((status) => ({ method: status.method, target: status.target }));
    const preferred = methods.some((entry) => entry.method === settings.twoFactorPreferred)
        ? settings.twoFactorPreferred
        : (methods[0]?.method ?? null);
    return { methods, preferred };
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
    if (!throttle.ok) return { error: "Too many codes asked for. Wait before asking for another." };

    const [settings, statuses] = await Promise.all([
        getUserSecurity(userId),
        describeTwoFactorMethods(userId)
    ]);
    const usable = statuses.filter((status) => status.enabled && status.available && status.method !== "totp");
    const asked = usable.find((status) => status.method === input.requested);
    const preferred = usable.find((status) => status.method === settings.twoFactorPreferred);
    const chosen = (asked ?? preferred ?? usable[0])?.method;
    if (chosen === undefined || chosen === "totp") {
        return { error: "This account has no way to be sent a code." };
    }

    const { destination } = await resolveDestination(userId, chosen);
    // Re-resolved rather than carried over from the status above, so the send
    // uses the real address instead of the masked one shown on screen.
    if (!destination) return { error: "That method stopped being usable." };

    const result =
        chosen === "email"
            ? await sendCodeByEmail(destination.address, code)
            : await sendCodeByWhatsApp(destination, code);

    await recordAudit({
        actorId: userId,
        action: result.error ? "account.2fa.code-failed" : "account.2fa.code-sent",
        metadata: { method: chosen }
    });
    return result;
}

async function sendCodeByEmail(address: string, code: string): Promise<{ error?: string }> {
    const { text, html } = messageBody(code);
    return sendAuthEmail({ to: address, subject: "Your Polaris sign-in code", text, html });
}

/**
 * Hand the code straight to the bridge rather than through the inbox, so it is
 * never written into the conversation history: a code that outlives the minute
 * it was good for is a code sitting in a database for no reason.
 */
async function sendCodeByWhatsApp(destination: Destination, code: string): Promise<{ error?: string }> {
    if (!destination.channelId) return { error: "No WhatsApp channel to send through." };
    const { text } = messageBody(code);
    try {
        await bridgeSend(destination.channelId, {
            peerId: normalizePeerId("whatsapp", destination.address),
            text
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The messaging bridge refused the message." };
    }
}
