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
import { BREACHED_PASSWORD_MESSAGE, setupSchema } from "@polaris/core";
import { assignRole, hasAnyUser, provisionUser, seedDefaultRoles, setUserAdmin } from "@polaris/auth";

export async function completeSetupAction(input: unknown): Promise<{ error?: string }> {
    const parsed = setupSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    if (await hasAnyUser()) return { error: "Setup is already complete. Sign in instead." };

    const expected = loadEnv().POLARIS_SETUP_TOKEN;
    if (!expected) return { error: "No setup token is configured on the server" };
    if (!tokenMatchesHash(parsed.data.token, hashToken(expected))) {
        return { error: "Invalid setup token" };
    }

    // The client asks the same corpus as the password is typed; this is the copy
    // that decides. Fails open, so an outage at somebody else's API cannot be the
    // reason nobody can set this Polaris up at all.
    if (await passwordIsBreached(parsed.data.password)) return { error: BREACHED_PASSWORD_MESSAGE };

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
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Setup failed" };
    }
}
