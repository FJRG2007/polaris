/**
 * Why a public link was refused, in the visitor's language.
 *
 * A snippet and a published note run the same gates in the same order and
 * refuse for the same reasons, so they say the same words. The visitor usually
 * has no account, so the language is the request's: the cookie, then the
 * browser's.
 */

import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";

const DENIALS: Readonly<Record<string, NamespaceKey<"publicPages">>> = {
    not_found: "denied.notFound",
    revoked: "denied.revoked",
    expired: "denied.expired",
    exhausted: "denied.exhausted",
    scheduled: "denied.scheduled",
    ip_not_allowed: "denied.network",
    country_not_allowed: "denied.location",
    ip_flagged: "denied.network",
    sign_in_required: "denied.signIn",
    not_invited: "denied.notInvited",
    password_required: "denied.protected"
};

/** The message for a gate's refusal, falling back to the generic one rather
 *  than naming a reason nobody wrote words for. */
export async function linkDenialMessage(reason: string): Promise<string> {
    return (await getTranslations("publicPages"))(DENIALS[reason] ?? "denied.unavailable");
}
