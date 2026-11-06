"use server";

/** Setting the account's own password in place of a temporary one. */

import { resolveSession } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { recoveryResetSchema } from "@polaris/core";
import { validationMessage } from "@/components/i18n/validation-message";
import { replaceTemporaryPassword } from "@/lib/admin-credentials-service";

/** The new password is the reset schema's own field, so the length rule is the
 *  one every other password form here enforces. */
const newPasswordSchema = recoveryResetSchema.pick({ newPassword: true });

export async function replaceTemporaryPasswordAction(input: unknown): Promise<{ error?: string }> {
    const session = await resolveSession();
    if (!session) return { error: (await getTranslations("auth"))("changePassword.signedOut") };
    const parsed = newPasswordSchema.safeParse(input);
    const tv = await getTranslations("validation");
    if (!parsed.success)
        return { error: validationMessage(tv, parsed.error.issues[0]?.message ?? "") };
    const result = await replaceTemporaryPassword(
        session.id,
        session.sessionId,
        parsed.data.newPassword
    );
    return result.error ? { error: validationMessage(tv, result.error) } : {};
}
