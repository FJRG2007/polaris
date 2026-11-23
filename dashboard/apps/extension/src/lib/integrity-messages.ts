/**
 * The one message the page check (entrypoints/integrity.ts) sends the worker,
 * outside the closed list in `messages.ts`: it carries no vault data either way,
 * and the worker answers it only for a page of a server somebody added.
 */

import type { IntegrityVerdict } from "@polaris/core/integrity";

export const INTEGRITY_CHECK = "integrityCheck";

export type IntegrityReply =
    | {
          readonly ok: true;
          readonly verdict: IntegrityVerdict;
          /** The warning's words, in the extension's language. */
          readonly words: { readonly title: string; readonly body: string; readonly files: string; readonly dismiss: string };
      }
    | { readonly ok: false };
