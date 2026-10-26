"use server";

/**
 * Remote access through Tailscale, from Admin > Domains. Admin-gated like the rest
 * of the page: these put the machine on a tailnet and can open it to the internet.
 * A refusal comes back as a sentence in the result rather than a throw, since Next
 * hides a thrown message in production.
 */

import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import {
    appPublicInputSchema,
    connectInputSchema,
    togglesInputSchema
} from "@/lib/tailscale/tailscale-model";
import {
    connectTailscale,
    disconnectTailscale,
    setTailnetAppPublic,
    setTailscaleToggles,
    tailscaleView,
    TailscaleRefusal,
    type TailscaleView
} from "@/lib/tailscale/tailscale-service";

export interface TailscaleResult {
    readonly view: TailscaleView | null;
    readonly error: string | null;
}

async function settle(
    actorId: string,
    action: string,
    work: (limited: string) => Promise<void>
): Promise<TailscaleResult> {
    const t = await getTranslations("admin");
    try {
        await work(t("domains.tailscale.limited"));
    } catch (error) {
        if (error instanceof TailscaleRefusal) return { view: null, error: error.message };
        console.error("polaris: tailscale:", error instanceof Error ? error.message : error);
        return { view: null, error: t("domains.tailscale.failed") };
    }
    await recordAudit({
        actorId,
        action,
        targetType: "setting",
        targetId: "tailscale"
    }).catch(() => undefined);
    return { view: await tailscaleView(), error: null };
}

/** Turn remote access on, with a pasted auth key or none (the login link). */
export async function connectTailscaleAction(input: unknown): Promise<TailscaleResult> {
    const actor = await requireAdmin();
    const parsed = connectInputSchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("admin");
        return { view: null, error: t("domains.tailscale.badKey") };
    }
    const key = parsed.data.authKey || null;
    return settle(actor.id, "domains.tailscale.connect", (limited) =>
        connectTailscale(key, limited)
    );
}

/** Change who the machine answers: the tailnet only, or the internet too. */
export async function setTailscaleTogglesAction(input: unknown): Promise<TailscaleResult> {
    const actor = await requireAdmin();
    const parsed = togglesInputSchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("admin");
        return { view: null, error: t("domains.tailscale.funnelNeedsServe") };
    }
    return settle(actor.id, "domains.tailscale.toggles", (limited) =>
        setTailscaleToggles(parsed.data, limited)
    );
}

/** Sign the machine out of the tailnet and stop the component. */
export async function disconnectTailscaleAction(): Promise<TailscaleResult> {
    const actor = await requireAdmin();
    return settle(actor.id, "domains.tailscale.disconnect", () => disconnectTailscale());
}

/** Open one app's tailnet address to the internet through Funnel, or close it. */
export async function setTailnetAppPublicAction(input: unknown): Promise<TailscaleResult> {
    const actor = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = appPublicInputSchema.safeParse(input);
    if (!parsed.success) return { view: null, error: t("domains.tailscale.appPublicUnknown") };
    const { hostname, public: open } = parsed.data;
    return settle(actor.id, "domains.tailscale.appPublic", (limited) =>
        setTailnetAppPublic(hostname, open, {
            limited,
            unknown: t("domains.tailscale.appPublicUnknown"),
            "no-port": t("domains.tailscale.appPublicFull")
        })
    );
}
