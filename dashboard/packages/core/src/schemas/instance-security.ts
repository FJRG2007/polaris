/**
 * What this deployment demands of every account on it, as opposed to what an
 * account demands of itself.
 *
 * There is one setting here and it is the one an operator actually has an
 * opinion about: whether an account may reach Polaris at all without a second
 * factor. A password is one secret, it is reused, and it leaks in other people's
 * breaches; on a deployment that runs someone's servers and holds their files,
 * "the password was enough" is a decision worth making deliberately rather than
 * by default. So it is on unless an operator turns it off.
 *
 * It applies to accounts that already exist, not only to new ones. A requirement
 * that only bound people who signed up after it was switched on would leave every
 * account that predates it exactly as it was, which is to say it would protect
 * nobody who is already here. Existing accounts meet it at their next sign-in.
 *
 * Which factors count is the second half, because the answer depends on the
 * deployment. The authenticator is always accepted and cannot be taken out of the
 * list: it needs nothing - no mail channel, no confirmed address, no bridge - so
 * it is the one factor that can still be armed when everything else is broken,
 * and a requirement nobody can satisfy locks out the whole instance.
 */

import { z } from "zod";

/**
 * The factors an account can arm to satisfy the requirement.
 *
 * A subset of the methods a challenge can use, and deliberately smaller. WhatsApp
 * delivers a code perfectly well once it is set up, but setting it up needs a
 * confirmed number and one of the account's own connected channels - neither of
 * which somebody signing in for the first time has - so it can be a way in but
 * never the way an account gets started.
 */
export const SECOND_FACTOR_ENROLLMENTS = ["totp", "email"] as const;

export type SecondFactorEnrollment = (typeof SECOND_FACTOR_ENROLLMENTS)[number];

/** How each one presents itself on the admin screen and on the enrollment step. */
export const SECOND_FACTOR_ENROLLMENT_INFO: Record<
    SecondFactorEnrollment,
    { label: string; description: string; requirement: string | null }
> = {
    totp: {
        label: "Authenticator app",
        description: "A code the phone generates on its own, with no network involved.",
        // Nothing: this is why it cannot be turned off.
        requirement: null
    },
    email: {
        label: "Email code",
        description: "A code sent to the address on the account, which confirms the address as it goes.",
        requirement: "An email channel Polaris can send from."
    }
};

export const instanceSecuritySchema = z.object({
    /** Every account carries a second factor before it can use Polaris. */
    requireSecondFactor: z.boolean(),
    /**
     * The factors that satisfy the requirement. The authenticator is folded back
     * in whatever arrives, so a stored list that lost it - written by an older
     * build, or hand-edited - cannot produce an instance nobody can get into.
     */
    acceptedFactors: z
        .array(z.enum(SECOND_FACTOR_ENROLLMENTS))
        .transform((values) => Array.from(new Set(["totp" as const, ...values]))),
    /**
     * Ask for the second step after a sign-in with a connected account as well.
     *
     * Defaulted rather than required, so a policy stored before this existed goes
     * on parsing instead of falling back to the defaults wholesale - which would
     * silently undo whatever the operator had chosen above it.
     */
    challengeConnectionSignIn: z.boolean().default(false)
});

export type InstanceSecurityPolicy = z.infer<typeof instanceSecuritySchema>;

/**
 * What a deployment that has never been configured asks for.
 *
 * On, and both factors accepted. Accepting the email code costs nothing on a
 * deployment that cannot send mail - the enrollment step only ever offers a factor
 * that can actually be armed right now - and on one that can, it means the person
 * signing in does not have to go and install an authenticator app first.
 *
 * The connected-account challenge is off. Signing in through GitHub or Google
 * already means answering that account's own sign-in, which for the people who
 * use it is a second factor and a hardware key more often than not; asking for a
 * code on top of it makes the shortest way in the longest one, and the account
 * that would have to be broken first is not this one.
 */
export const INSTANCE_SECURITY_DEFAULTS: InstanceSecurityPolicy = {
    requireSecondFactor: true,
    acceptedFactors: ["totp", "email"],
    challengeConnectionSignIn: false
};
