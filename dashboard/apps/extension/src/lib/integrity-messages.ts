/**
 * The one message the page check (entrypoints/integrity.ts) sends the worker,
 * outside the closed list in `messages.ts`: it carries no vault data either way,
 * and the worker answers it only for a page of a server somebody added.
 */

import type { PageVerdict } from "@polaris/core/integrity";
import type { IntegrityWords, OutdatedWords } from "@polaris/core/integrity-guard";

export const INTEGRITY_CHECK = "integrityCheck";

export type IntegrityReply =
    | {
          readonly ok: true;
          readonly verdict: PageVerdict;
          /** The warning's words, in the extension's language. */
          readonly words: IntegrityWords;
          /** The words of the reload offer over a page of an earlier build. */
          readonly outdated: OutdatedWords;
      }
    | { readonly ok: false };
