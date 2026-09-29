/**
 * The vault's vocabulary that lives as data - the kinds of item, how a website
 * matches, the kinds of client - in the reader's language.
 *
 * The English tables in `@polaris/core` and `lib/vault` are read by code with no
 * reader (an export, a log line); a screen draws the words through these, with
 * the translator it already holds.
 */

import * as core from "@polaris/core";
import type { VaultClientKind } from "@polaris/core";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type VaultT = NamespaceTranslator<"vault">;

const TYPE_KEYS: Record<core.CipherType, NamespaceKey<"vault">> = {
    [core.CIPHER_LOGIN]: "labels.types.login",
    [core.CIPHER_SECURE_NOTE]: "labels.types.note",
    [core.CIPHER_CARD]: "labels.types.card",
    [core.CIPHER_IDENTITY]: "labels.types.identity",
    [core.CIPHER_SSH_KEY]: "labels.types.sshKey"
};

const MATCH_KEYS: Record<core.UriMatch, NamespaceKey<"vault">> = {
    [core.URI_MATCH_DOMAIN]: "labels.uriMatch.domain",
    [core.URI_MATCH_HOST]: "labels.uriMatch.host",
    [core.URI_MATCH_STARTS_WITH]: "labels.uriMatch.startsWith",
    [core.URI_MATCH_EXACT]: "labels.uriMatch.exact",
    [core.URI_MATCH_REGEX]: "labels.uriMatch.regex",
    [core.URI_MATCH_NEVER]: "labels.uriMatch.never"
};

const CLIENT_KEYS: Partial<Record<VaultClientKind, NamespaceKey<"vault">>> = {
    extension: "labels.clientKinds.extension",
    browser: "labels.clientKinds.browser",
    mobile: "labels.clientKinds.mobile",
    desktop: "labels.clientKinds.desktop",
    cli: "labels.clientKinds.cli"
};

/** What a kind of item is called, or nothing for a type this does not know. */
export function cipherTypeLabel(t: VaultT, type: number): string {
    const key = TYPE_KEYS[type as core.CipherType];
    return key ? t(key) : "";
}

/** How a website on a login decides where it counts. */
export function uriMatchLabel(t: VaultT, match: core.UriMatch): string {
    return t(MATCH_KEYS[match]);
}

/** What kind of app a connected client is. */
export function clientKindText(t: VaultT, kind: VaultClientKind): string {
    const key = CLIENT_KEYS[kind];
    return key ? t(key) : t("labels.clientKinds.other");
}
