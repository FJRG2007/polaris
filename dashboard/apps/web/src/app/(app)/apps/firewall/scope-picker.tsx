"use client";

/**
 * Choosing what the rules on this page apply to.
 *
 * This used to be a flat list of every project and environment down the left, which
 * does not survive contact with a real instance: two projects with three environments
 * each is already nine entries before a single server or service appears, and the
 * list is the same length whether you came here for Polaris or for one container.
 *
 * So it works the way Deploy's header does instead, in the same place: the two
 * selects are portalled into the app bar beside the app switcher, because the scope
 * is what the whole screen is about rather than one control on it. The choice lives
 * in the URL, so a scope can be linked to, reloaded, and reached from a service's
 * own page.
 */

import { Select } from "@polaris/ui";
import { HeaderPortal } from "@/components/header-portal";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PagedPicker } from "@/components/paged-picker";
import { firewallScopeOptionsAction } from "./actions";
import type { FirewallScopeOption } from "@/lib/firewall-scope-options-schema";
import { SCOPE_KINDS, scopeKindLabel, scopeNeedsTarget, type ScopeKind } from "./scope-kinds";

const optionLabel = (option: FirewallScopeOption) =>
    option.path ? `${option.path} / ${option.name}` : option.name;

export function ScopePicker({
    kind,
    id,
    label,
    offerMarketplace,
    canOperate
}: {
    kind: ScopeKind;
    /** The chosen target, resolved by the page - empty when the kind has none. */
    id: string;
    label: string;
    /** Whether anything is installed from the marketplace to offer a shortcut to. */
    offerMarketplace: boolean;
    /** The two instance-wide scopes are operator controls, so a member is not offered
     *  them at all rather than being offered them and refused. */
    canOperate: boolean;
}) {
    const t = useTranslations("firewall");
    const router = useRouter();
    const params = useSearchParams();
    const kinds = SCOPE_KINDS.filter(
        (entry) => canOperate || (entry !== "polaris" && entry !== "global")
        // Nothing installed from the marketplace means no shortcut to offer, and a
        // kind that resolves to an empty list is one that only wastes a click.
    ).filter((entry) => entry !== "marketplace" || offerMarketplace);

    function go(nextKind: ScopeKind, nextId: string) {
        const next = new URLSearchParams(params.toString());
        next.set("scope", nextKind);
        if (nextId) next.set("id", nextId);
        else next.delete("id");
        router.push(`/apps/firewall?${next.toString()}`);
    }

    const kindSelect = (
        <Select
            value={kind}
            aria-label={t("picker.scope")}
            className="h-8 min-w-0 flex-1 font-medium md:w-48 md:min-w-[12rem] md:flex-none"
            options={kinds.map((entry) => ({ value: entry, label: scopeKindLabel(t, entry) }))}
            onValueChange={(value) => {
                // Moving to a kind that names something lands on its first entry - the
                // page resolves it - so it is never showing a chooser with nothing chosen.
                go(value as ScopeKind, "");
            }}
        />
    );

    const targetSelect = !scopeNeedsTarget(kind) ? null : id ? (
        <PagedPicker<FirewallScopeOption>
            read={firewallScopeOptionsAction}
            scope={{ kind }}
            cache="firewall-scope"
            value={id}
            selectedLabel={label}
            itemLabel={optionLabel}
            onValueChange={(value) => go(kind, value)}
            aria-label={t("picker.target")}
            placeholder={t("picker.target")}
            searchPlaceholder={t("picker.search")}
            emptyText={t("picker.empty")}
            className="h-8 min-w-0 flex-1 md:w-60 md:min-w-[15rem] md:flex-none"
        />
    ) : (
        <span className="whitespace-nowrap text-sm text-muted-foreground">{t("picker.none")}</span>
    );

    return (
        <>
            {/* In the top bar where there is room beside the app switcher, and at the
                top of the page where there is not - the same controls, never both. */}
            <HeaderPortal>
                <span className="hidden text-muted-foreground/40 md:inline">/</span>
                <span className="hidden items-center gap-2 md:flex">
                    {kindSelect}
                    {targetSelect ? <span className="text-muted-foreground/40">/</span> : null}
                    {targetSelect}
                </span>
            </HeaderPortal>

            <div className="flex items-center gap-2 md:hidden">
                {kindSelect}
                {targetSelect}
            </div>
        </>
    );
}
