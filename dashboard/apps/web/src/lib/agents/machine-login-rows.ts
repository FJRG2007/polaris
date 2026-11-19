/**
 * The connection row of an agent signed in on the sessions' machine
 * (`machine-logins.ts`), written when a sign-in finishes, a check finds the tool
 * signed in, or an account whose connected agents were only kept as a list
 * (`home-signins.ts`) is first read.
 *
 * The fingerprint is fixed per agent, so the unique index on (owner, provider,
 * fingerprint) turns a second insert - two reads racing - into a no-op instead
 * of a duplicate row. Kept apart from `machine-logins.ts` so the sign-in runtime
 * can write rows without importing what reads its own catalogue.
 */

import { prisma } from "@polaris/db";
import { translate } from "@/lib/i18n/translate";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { isMachineLogin, MACHINE_LOGIN } from "@/lib/agents/machine-login-config";

/** An agent's login on the machine, as the row for it needs it. */
export interface MachineSignin {
    env: string;
    slug: string;
    /** The tool's name, which the row's default name is built from. */
    label: string;
}

function fingerprintOf(env: string): string {
    return `machine-login:${env}`;
}

/** Which unique index a failed insert hit, or null when it was not a clash. */
function clashOf(caught: unknown): "fingerprint" | "name" | null {
    if (typeof caught !== "object" || caught === null) return null;
    const error = caught as { code?: string; meta?: { target?: unknown } };
    if (error.code !== "P2002") return null;
    const target = Array.isArray(error.meta?.target)
        ? error.meta.target.join(",")
        : String(error.meta?.target ?? "");
    return target.toLowerCase().includes("fingerprint") ? "fingerprint" : "name";
}

/**
 * A row for each of these logins the person does not have one for yet, at the
 * end of their order. Idempotent: an agent that already has a row is left as it
 * is, renamed, moved or switched off, and an insert that loses a race to
 * another read is dropped.
 */
export async function ensureMachineLogins(userId: string, signins: readonly MachineSignin[]): Promise<void> {
    if (signins.length === 0) return;
    const held = await prisma.userModelKey.findMany({
        where: { userId },
        select: { provider: true, name: true, config: true, priority: true }
    });
    const present = new Set(held.filter((row) => isMachineLogin(row.config)).map((row) => row.provider));
    const missing = signins.filter((signin) => !present.has(signin.slug));
    if (missing.length === 0) return;
    const locale = await getUserLocale(userId);
    const taken = new Set(held.map((row) => row.name.toLowerCase()));
    let priority = held.reduce((most, row) => Math.max(most, row.priority), -1) + 1;
    for (const signin of missing) {
        const base = translate(locale, "components.modelKeys.machineLoginName", { tool: signin.label });
        for (let n = 1; n < 50; n++) {
            const name = n === 1 ? base : `${base} ${n}`;
            if (taken.has(name.toLowerCase())) continue;
            try {
                await prisma.userModelKey.create({
                    data: {
                        userId,
                        provider: signin.slug,
                        name,
                        priority,
                        config: JSON.stringify({ [MACHINE_LOGIN]: signin.env }),
                        encryptedSecret: new Uint8Array(0),
                        secretNonce: new Uint8Array(0),
                        secretKeyId: "",
                        secretFingerprint: fingerprintOf(signin.env),
                        keyHint: ""
                    }
                });
                taken.add(name.toLowerCase());
                priority += 1;
                break;
            } catch (caught) {
                const clash = clashOf(caught);
                if (clash === null) throw caught;
                // Another read wrote this agent's row first.
                if (clash === "fingerprint") break;
                taken.add(name.toLowerCase());
            }
        }
    }
}
