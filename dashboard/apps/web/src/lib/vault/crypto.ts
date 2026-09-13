/**
 * The vault's cryptography, which now lives in `@polaris/vault-crypto`.
 *
 * It moved because a second client needs exactly this and nothing else: the
 * browser extension derives the same master key, opens the same enc strings and
 * wraps the same org keys, and a second copy of a vault's cryptography is how two
 * clients end up producing vaults only one of them can open. One module, two
 * consumers, one set of Bitwarden test vectors pinning it.
 *
 * This file stays as the name the app already imports - the screens ask for
 * `@/lib/vault/crypto` in a dozen places and there is nothing to gain by
 * rewriting them - and the rule the old header stated still holds: nothing here
 * has a server-side counterpart, and it must never grow one. A server that can
 * decrypt a vault is a server whose database is the vault.
 */

export * from "@polaris/vault-crypto";
