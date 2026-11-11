"use server";

import { loadEnv } from "@polaris/config";

/**
 * The address sign-in is always accepted on, for the screen that has to say
 * where to go instead.
 *
 * A browser on an address this deployment does not trust (a LAN IP typed by
 * hand, an old hostname) is refused by the auth library's origin check before
 * the password is even looked at. That refusal used to be shown as "wrong
 * password", so a person with a perfectly good account was left retyping it.
 * POLARIS_APP_URL is always on the trusted list, so it is the one to name.
 *
 * enigma:allow-unlimited-auth - takes no credential and checks nothing; it
 * returns the address the sign-in page already links from every email.
 */
export async function signInAddressAction(): Promise<string> {
    return loadEnv().POLARIS_APP_URL;
}
