"use server";

/**
 * Claim an invite. The email is fixed by the invite; the recipient sets their
 * name, username and password, and presents whatever else the invite asks for -
 * a code instead of a link, a one-time password, or both.
 *
 * The address the request came from is read here rather than taken from the
 * client: it is half of what decides whether the invite may be claimed at all.
 */

import { clientIp } from "@/lib/request-context";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import { claimInvite, resolveInvite } from "@/lib/invite-service";
import { BREACHED_PASSWORD_MESSAGE, claimInviteSchema, inviteCodeField, INVITE_REFUSALS } from "@polaris/core";

/**
 * Check an invitation code before asking its holder for anything else. Answers
 * with the address the invite is for, so the join form can name it, and with
 * whether a one-time password is still owed.
 */
export async function lookupInviteCodeAction(
    input: unknown
): Promise<{ invite?: { email: string; needsPassword: boolean }; error?: string }> {
    const parsed = inviteCodeField.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid code" };
    const { invite, refusal } = await resolveInvite({ code: parsed.data }, await clientIp());
    if (!invite) return { error: INVITE_REFUSALS[refusal ?? "unavailable"] };
    return { invite: { email: invite.email, needsPassword: invite.needsPassword } };
}

export async function acceptInviteAction(input: unknown): Promise<{ email?: string; error?: string }> {
    const parsed = claimInviteSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    const { token, code, oneTimePassword, name, username, password } = parsed.data;
    if (!token && !code) return { error: "Missing invite token" };
    // Checked here as well as in the browser, because the browser is not the
    // enforcement point. Unknown answers pass: an outage at somebody else's API
    // must never be the reason an invited person cannot join.
    if (await passwordIsBreached(password)) return { error: BREACHED_PASSWORD_MESSAGE };

    const result = await claimInvite({
        token: token || undefined,
        code: code || undefined,
        oneTimePassword: oneTimePassword || undefined,
        name,
        username,
        password,
        ip: await clientIp()
    });
    if (result.refusal) return { error: INVITE_REFUSALS[result.refusal] };
    if (result.error) return { error: result.error };
    return { email: result.email };
}
