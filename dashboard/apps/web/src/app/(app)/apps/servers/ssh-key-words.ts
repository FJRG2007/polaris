/**
 * The shared key schemas speak English; these are the catalog keys the reader
 * sees those sentences under, for the panel and its server actions alike.
 */

const SCHEMA_WORDS = {
    "Paste a public key": "sshKeys.errors.empty",
    "That key is too long": "sshKeys.errors.tooLong",
    "Paste one key per line": "sshKeys.errors.oneLine",
    "That is not an SSH public key": "sshKeys.errors.notKey",
    "That is a private key. Paste the public one": "sshKeys.errors.privateKey",
    "Use letters, digits, spaces and . _ - @": "sshKeys.errors.label"
} as const;

export function sshKeyIssueKey(message: string | undefined) {
    return (
        (message && SCHEMA_WORDS[message as keyof typeof SCHEMA_WORDS]) || "sshKeys.errors.invalid"
    );
}
