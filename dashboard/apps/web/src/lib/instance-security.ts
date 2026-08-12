/**
 * The deployment's own demand on every account: carry a second factor, or do not
 * get in.
 *
 * Two questions live here and nothing else does. What the instance asks for, which
 * an administrator sets under Management > Security; and what one account still
 * owes against it, which the session guard asks on every request and the enrollment
 * step asks to know what to offer. Keeping both in one module is what stops the
 * gate and the screen that clears it from disagreeing - a gate that holds somebody
 * for a factor the screen does not offer is a locked instance.
 *
 * Where the factor is asked for is part of the first question, so it is settled
 * here too: a sign-in with a connected account defers to that account's own gates
 * and is not challenged again unless the instance or the person says otherwise.
 *
 * Whether a factor can be armed is a fact about the deployment, not about the
 * policy: the authenticator always can, and the email code only where there is a
 * channel to send from. So the accepted list is filtered by what actually works
 * before anybody is shown it, and an instance whose mail breaks falls back to
 * asking for an authenticator rather than asking for something impossible.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getSetting, setSetting } from "@/lib/setting-store";
import { getUserSecurity, twoFactorEnabled } from "@polaris/auth";
import {
    INSTANCE_SECURITY_DEFAULTS,
    instanceSecuritySchema,
    type InstanceSecurityPolicy,
    type SecondFactorEnrollment
} from "@polaris/core";

const POLICY_KEY = "security.second-factor";

/**
 * What this instance asks for. Anything unreadable reads as the defaults rather
 * than as "ask for nothing": a policy row somebody corrupted should not quietly
 * drop the requirement it was written to impose.
 *
 * Memoized per request. The session guard asks on every navigation, and one
 * indexed read repeated eight times across a page's server components is eight
 * reads that answer the same.
 */
export const getInstanceSecurity = cache(async (): Promise<InstanceSecurityPolicy> => {
    const stored = await getSetting(POLICY_KEY);
    if (!stored) return INSTANCE_SECURITY_DEFAULTS;
    try {
        const parsed = instanceSecuritySchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : INSTANCE_SECURITY_DEFAULTS;
    } catch {
        return INSTANCE_SECURITY_DEFAULTS;
    }
});

/** Replace the policy. Validated by the caller against the same schema. */
export async function setInstanceSecurity(policy: InstanceSecurityPolicy): Promise<void> {
    await setSetting(POLICY_KEY, JSON.stringify(policy));
}

/** One way an account can arm its factor, as the enrollment step offers it. */
export interface EnrollmentOption {
    factor: SecondFactorEnrollment;
    /** Where an emailed code would go. Null for the authenticator. */
    target: string | null;
}

/**
 * The ways this account could arm a factor right now: accepted by the instance,
 * and able to work.
 *
 * The authenticator is always among them, which is what makes this list never
 * empty and the requirement always satisfiable. The email code needs somewhere to
 * send and something to send with; the address is the one the account signs in
 * with, confirmed or not, because confirming it is exactly what answering the code
 * does.
 */
export async function enrollmentOptions(userId: string): Promise<EnrollmentOption[]> {
    const policy = await getInstanceSecurity();
    const options: EnrollmentOption[] = [{ factor: "totp", target: null }];
    if (!policy.acceptedFactors.includes("email")) return options;

    const [user, mail] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
        getAuthMailStatus()
    ]);
    if (user?.email && mail.channelId) options.push({ factor: "email", target: user.email });
    return options;
}

/**
 * Whether this account has to arm a factor before it is let any further.
 *
 * Asked on every request behind the session guard, so it answers on the policy
 * alone for the deployments that ask for nothing - which is one memoized read -
 * and only then looks at the account.
 */
export async function owesSecondFactor(userId: string): Promise<boolean> {
    const policy = await getInstanceSecurity();
    if (!policy.requireSecondFactor) return false;
    return !(await twoFactorEnabled(userId));
}

/**
 * Whether a sign-in with a connected GitHub or Google account still owes the
 * second-factor challenge.
 *
 * Two opinions, and either one is enough: the instance can demand it of every
 * account, and an account can ask for it when the instance does not. Neither
 * cancels the other - the same rule the rest of this screen runs on, where a
 * person may add protection the deployment did not ask for and cannot drop what
 * it did.
 *
 * Off on both is the default, and it is the interesting case: the provider has
 * just put its own sign-in in front of this one, which for most people is a
 * second factor already. An account with no factor armed is not challenged
 * whatever this returns, so the answer only ever matters for the accounts that
 * have one.
 */
export async function connectionSignInChallenged(userId: string): Promise<boolean> {
    const policy = await getInstanceSecurity();
    if (policy.challengeConnectionSignIn) return true;
    return (await getUserSecurity(userId)).challengeConnectionSignIn;
}
