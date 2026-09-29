/**
 * How a session got in, and what kind of client a vault connection is, in the
 * reader's words.
 *
 * Core names both in English (`signInSummary`, `clientKindLabel`), because the
 * audit log and the security notices store and read them too. The screens say
 * them through the `components` catalog instead. A connection provider is named
 * by its brand, which no language changes.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { CONNECTION_PROVIDERS, type SecondFactor, type SignInRecord } from "@polaris/core";

type Words = NamespaceTranslator<"components">;

const OWN_METHODS: Readonly<Record<string, NamespaceKey<"components">>> = {
    password: "signIn.methods.password",
    passkey: "signIn.methods.passkey",
    "email-link": "signIn.methods.emailLink",
    "qr-code": "signIn.methods.qrCode"
};

const SECOND_FACTORS: Readonly<Record<SecondFactor, NamespaceKey<"components">>> = {
    totp: "signIn.secondFactors.totp",
    "email-code": "signIn.secondFactors.emailCode",
    "whatsapp-code": "signIn.secondFactors.whatsappCode",
    code: "signIn.secondFactors.code",
    "backup-code": "signIn.secondFactors.backupCode",
    "trusted-device": "signIn.secondFactors.trustedDevice"
};

/** Each half of how a session signed in, in order: the method, then the second factor. */
export function signInParts(t: Words, record: SignInRecord): string[] {
    const parts: string[] = [];
    if (record.method) {
        const own = OWN_METHODS[record.method];
        parts.push(
            own ? t(own) : (CONNECTION_PROVIDERS.find((provider) => provider.slug === record.method)?.name ?? record.method)
        );
    }
    if (record.secondFactor) parts.push(t(SECOND_FACTORS[record.secondFactor]));
    return parts;
}

/** The same as core's `signInSummary`: the parts joined, or that nothing was recorded. */
export function signInText(t: Words, record: SignInRecord): string {
    const parts = signInParts(t, record);
    return parts.length === 0 ? t("signIn.notRecorded") : parts.join(" + ");
}

const CLIENT_KINDS: Readonly<Record<string, NamespaceKey<"components">>> = {
    extension: "clientKinds.extension",
    browser: "clientKinds.browser",
    mobile: "clientKinds.mobile",
    desktop: "clientKinds.desktop",
    cli: "clientKinds.cli"
};

/** What kind of client a vault connection is; the same answers as `clientKindLabel`. */
export function clientKindText(t: Words, kind: string): string {
    const key = CLIENT_KINDS[kind];
    return key ? t(key) : t("clientKinds.other");
}
