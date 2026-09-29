"use server";

/**
 * One-time administrator setup. Creating the first account is authorized by the
 * setup token the installer generated (checked in constant time). It only works
 * while no account exists; afterwards setup is permanently closed. The new user
 * is made an administrator and the built-in roles are seeded.
 */

import { auth } from "@/lib/auth";
import { loadEnv } from "@polaris/config";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import { hashToken, tokenMatchesHash } from "@polaris/core/tokens";
import { setupSchema } from "@polaris/core";
import { assignRole, hasAnyUser, provisionUser, seedDefaultRoles, setUserAdmin } from "@polaris/auth";
import { adoptRequestLocale, getTranslations } from "@/lib/i18n/request";
import { validationMessage } from "@/components/i18n/validation-message";

export async function completeSetupAction(input: unknown): Promise<{ error?: string }> {
    const t = await getTranslations("auth");
    const tv = await getTranslations("validation");
    const parsed = setupSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0]?.message;
        return { error: issue === undefined ? t("setup.errors.invalidInput") : validationMessage(tv, issue) };
    }

    if (await hasAnyUser()) return { error: t("setup.errors.complete") };

    const expected = loadEnv().POLARIS_SETUP_TOKEN;
    if (!expected) return { error: t("setup.errors.noToken") };
    if (!tokenMatchesHash(parsed.data.token, hashToken(expected))) {
        return { error: t("setup.errors.invalidToken") };
    }

    // The client asks the same corpus as the password is typed; this is the copy
    // that decides. Fails open, so an outage at somebody else's API cannot be the
    // reason nobody can set this Polaris up at all.
    if (await passwordIsBreached(parsed.data.password)) return { error: tv("passwordBreached") };

    try {
        const user = await provisionUser(auth, {
            email: parsed.data.email,
            name: parsed.data.name,
            username: parsed.data.username,
            password: parsed.data.password
        });
        await setUserAdmin(user.id);
        await seedDefaultRoles();
        await assignRole(user.id, "admin");
        // The language this browser asks for, so the dashboard opens in it.
        await adoptRequestLocale(user.id);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : t("setup.errors.failed") };
    }
}
