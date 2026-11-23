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

/** The setting row the policy is stored under, read by the dashboard and the auth layer alike. */
export const INSTANCE_SECURITY_SETTING_KEY = "security.second-factor";

/** Who has to sign in with a passkey or a security key: nobody, administrators, everybody. */
export const PHISHING_RESISTANT_SCOPES = ["off", "admins", "everyone"] as const;

export type PhishingResistantScope = (typeof PHISHING_RESISTANT_SCOPES)[number];

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
    challengeConnectionSignIn: z.boolean().default(false),
    /**
     * Every new sign-in waits until one of the account's signed-in devices allows
     * it, whatever the account chose for itself, and even with an authenticator
     * armed. Defaulted for the same reason as the line above.
     */
    requireLoginApproval: z.boolean().default(false),
    /**
     * Whose sessions must have been opened with a passkey or a security key -
     * the sign-ins a look-alike site cannot replay, since the key answers only
     * for this address. Defaulted to nobody, so a policy stored before this
     * existed parses exactly as it did.
     */
    requirePhishingResistant: z.enum(PHISHING_RESISTANT_SCOPES).default("off"),
    /**
     * Every account confirms a phone number before it can use Polaris. Off unless
     * an administrator turns it on, and defaulted so a policy stored before this
     * existed parses exactly as it did. Only binds an account a confirmation code
     * can actually reach, and never an administrator: a requirement nobody can
     * meet would be a locked instance.
     */
    requirePhone: z.boolean().default(false),
    /**
     * Who turned the second-step requirement off, and when. Written by the server
     * from the session that saved it, never taken from the request; null while
     * the requirement is on, or when it was off before this was recorded.
     */
    secondFactorRiskAccepted: z
        .object({ by: z.string().min(1).max(200), at: z.string().datetime() })
        .nullable()
        .default(null)
});

/** Whether `scope` asks an account with this admin flag for a passkey sign-in. */
export function phishingResistantApplies(scope: PhishingResistantScope, isAdmin: boolean): boolean {
    return scope === "everyone" || (scope === "admins" && isAdmin);
}

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
    challengeConnectionSignIn: false,
    requireLoginApproval: false,
    requirePhishingResistant: "off",
    requirePhone: false,
    secondFactorRiskAccepted: null
};
