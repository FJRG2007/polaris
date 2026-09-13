/**
 * The six digits beside a saved login, which now live in `@polaris/vault-crypto`.
 *
 * They moved for the same reason the rest of the vault's cryptography did: the
 * browser extension shows the same codes, and a second implementation of a
 * one-time password is a second thing that can disagree with the site asking for
 * it. One module, two clients, one set of RFC test vectors pinning it.
 *
 * This file stays as the name the vault screens already import.
 */

export * from "@polaris/vault-crypto/totp";
