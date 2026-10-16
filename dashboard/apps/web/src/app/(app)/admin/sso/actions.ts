"use server";

/**
 * Single sign-on providers, as an administrator manages them. Every action
 * re-checks the administrator and parses its input with the schema the form
 * validates against; what goes wrong is logged here and answered with a key the
 * screen translates, never the underlying error.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import * as saml from "@/lib/saml-providers";
import { recordAudit } from "@/lib/audit-service";

type Outcome<T> = { ok: true; value: T } | { ok: false; problem: saml.SamlProblem | "invalid" | "failed"; message?: string };

const providerIdSchema = z.string().regex(core.SAML_PROVIDER_ID_PATTERN);

async function attempt<T>(label: string, run: () => Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: true, value: await run() };
    } catch (error) {
        if (error instanceof saml.SamlProviderError) return { ok: false, problem: error.problem };
        console.error(`[sso] ${label} failed`, error);
        return { ok: false, problem: "failed" };
    }
}

export async function saveSamlProviderAction(
    input: unknown,
    providerId: string | null
): Promise<Outcome<saml.SamlProviderView>> {
    const admin = await requireAdmin();
    const parsed = core.samlProviderInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, problem: "invalid", message: parsed.error.issues[0]?.message };
    const id = providerId === null ? null : providerIdSchema.safeParse(providerId);
    if (id && !id.success) return { ok: false, problem: "notFound" };
    const outcome = await attempt("save", () => saml.saveSamlProvider(parsed.data, admin.id, id ? id.data : null));
    if (outcome.ok) {
        await recordAudit({
            actorId: admin.id,
            action: providerId ? "instance.sso.updated" : "instance.sso.created",
            metadata: {
                providerId: outcome.value.providerId,
                domains: outcome.value.domains,
                allowSignUp: outcome.value.allowSignUp,
                enforced: outcome.value.enforced
            }
        });
        revalidatePath("/admin/sso");
    }
    return outcome;
}

export async function checkSamlProviderAction(providerId: string): Promise<Outcome<saml.SamlCheck[]>> {
    await requireAdmin();
    const id = providerIdSchema.safeParse(providerId);
    if (!id.success) return { ok: false, problem: "notFound" };
    const outcome = await attempt("check", () => saml.checkSamlProvider(id.data));
    revalidatePath("/admin/sso");
    return outcome;
}

export async function deleteSamlProviderAction(providerId: string): Promise<Outcome<null>> {
    const admin = await requireAdmin();
    const id = providerIdSchema.safeParse(providerId);
    if (!id.success) return { ok: false, problem: "notFound" };
    const outcome = await attempt("delete", async () => {
        await saml.deleteSamlProvider(id.data);
        return null;
    });
    if (outcome.ok) {
        await recordAudit({ actorId: admin.id, action: "instance.sso.deleted", metadata: { providerId: id.data } });
        revalidatePath("/admin/sso");
    }
    return outcome;
}
