/**
 * The second-factor challenge, reached when sign-in returns twoFactorRedirect.
 * better-auth holds a short-lived challenge cookie at this point and no session
 * exists yet, so the verification itself runs through its browser client - the
 * one that owns that cookie.
 *
 * What the screen may offer is resolved here instead, from that same cookie: the
 * account behind it decides which methods are on the table, and asking the
 * browser to name the account would turn this page into a way to ask which
 * methods any address has.
 */

import { challengeOptions, type ChallengeOptions } from "@/lib/two-factor-delivery";
import { pendingTwoFactorUserId } from "@/lib/two-factor-challenge";
import { TwoFactorView } from "./two-factor-view";

export const dynamic = "force-dynamic";

/** With no resolvable challenge there is nothing to describe, so the screen falls
 *  back to the authenticator - the one method that never depends on anything. */
const AUTHENTICATOR_ONLY: ChallengeOptions = {
    methods: [{ method: "totp", target: null }],
    preferred: "totp"
};

export default async function TwoFactorPage() {
    const userId = await pendingTwoFactorUserId();
    const options = userId ? await challengeOptions(userId) : AUTHENTICATOR_ONLY;
    return <TwoFactorView options={options.methods.length > 0 ? options : AUTHENTICATOR_ONLY} />;
}
