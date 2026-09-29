/**
 * Why a machine refused to enroll, in the reader's words.
 *
 * The enrollment keeps the English sentence it was refused with (it is stored,
 * and read again long after the machine said it), so the sentence is matched
 * back to its code here and said in the reader's language. Anything else - an
 * older wording, a reason with no code - passes through as it was stored.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";
import { ENROLLMENT_REFUSAL_MESSAGES, ENROLLMENT_USERNAME } from "@polaris/core";

export function enrollmentRefusalText(t: NamespaceTranslator<"servers">, message: string): string {
    for (const [code, english] of Object.entries(ENROLLMENT_REFUSAL_MESSAGES)) {
        if (english === message) {
            return t(`enroll.refusals.${code as keyof typeof ENROLLMENT_REFUSAL_MESSAGES}`, {
                login: ENROLLMENT_USERNAME
            });
        }
    }
    return message;
}
