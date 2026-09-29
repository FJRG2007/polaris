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
import { validationMessage } from "@/components/i18n/validation-message";

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

const UNLOCK_KEYS: Readonly<Record<number, NamespaceKey<"vault">>> = {
    [core.VAULT_LOCK_IMMEDIATELY]: "labels.unlock.immediately",
    1: "labels.unlock.m1",
    5: "labels.unlock.m5",
    15: "labels.unlock.m15",
    30: "labels.unlock.m30",
    60: "labels.unlock.h1",
    240: "labels.unlock.h4",
    [core.VAULT_LOCK_ON_TAB_CLOSE]: "labels.unlock.tabClose"
};

/** When an open vault locks itself (`VAULT_UNLOCK_TIMEOUTS`). */
export function unlockTimeoutLabel(t: VaultT, minutes: number): string {
    const key = UNLOCK_KEYS[minutes];
    return key ? t(key) : String(minutes);
}

/** What `lib/vault/portability` refuses a file with, by its English. */
const IMPORT_KEYS: Readonly<Record<string, NamespaceKey<"vault">>> = {
    "That file has no username, password or notes column.": "port.refusals.noColumns",
    "That export is encrypted. Export it again unencrypted.": "port.refusals.encrypted",
    "That export still has its passwords protected. In KeePass, export again with protection off.":
        "port.refusals.protected",
    "That file is not readable XML.": "port.refusals.badXml",
    "That XML is not a KeePass export.": "port.refusals.notKeePass",
    "A .kdbx is a KeePass database, not an export. In KeePass, use File > Export and pick KeePass XML or CSV.":
        "port.refusals.kdbx"
};

/** Why a file could not be imported, in the reader's words; a parser's own
 *  message passes through as it came. */
export function importRefusalText(t: VaultT, message: string): string {
    const key = IMPORT_KEYS[message];
    return key ? t(key) : message;
}

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

/** What `@polaris/core`'s vault schemas refuse with, by their English. */
const SCHEMA_KEYS: Readonly<Record<string, NamespaceKey<"vault">>> = {
    "Must be an encrypted value": "errors.schema.encrypted",
    "Unknown item type": "errors.schema.itemType",
    "Unknown send type": "errors.schema.sendType",
    "Give it a name": "errors.schema.name",
    "Mix at least two kinds of character - letters and numbers, or letters and punctuation.": "errors.schema.mix"
};

/** A vault schema's complaint in the reader's words: the vault's own, then the
 *  shared ones (a length), then as it came. */
export function vaultSchemaText(t: VaultT, validation: NamespaceTranslator<"validation">, message: string): string {
    const key = SCHEMA_KEYS[message];
    if (key) return t(key);
    // core's master password rule says its length with a full stop.
    const short = /^Use at least (\d+) characters\.$/.exec(message);
    if (short) return t("settings.tooShort", { count: Number(short[1]) });
    return validationMessage(validation, message);
}
