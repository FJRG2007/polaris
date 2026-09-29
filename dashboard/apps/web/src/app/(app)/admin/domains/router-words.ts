/**
 * The router guide in the reader's words.
 *
 * `lib/router-guide` keeps each brand's advice in English, next to the menu
 * names, buttons and field labels it quotes from that brand's own pages - which
 * stay as the router shows them, because that is what somebody is matching
 * against. What is Polaris talking - how to sign in, what to watch out for, the
 * generic brand's descriptions - is said through the `admin` catalog, keyed
 * `domainsRouter.brands.<brand>.<field>`, and falls back to the guide's own
 * English where the catalog has none.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import type { RouterBrandGuide } from "@/lib/router-guide";

type AdminWords = NamespaceTranslator<"admin">;

function said(t: AdminWords, key: string, english: string): string;
function said(t: AdminWords, key: string, english: string | null): string | null;
function said(t: AdminWords, key: string, english: string | null): string | null {
    if (english === null) return null;
    return t.has(key) ? t(key as NamespaceKey<"admin">) : english;
}

/** One brand's guide, with Polaris's own sentences in the reader's words. */
export function routerGuideIn(t: AdminWords, guide: RouterBrandGuide): RouterBrandGuide {
    const base = `domainsRouter.brands.${guide.id}`;
    const reserve =
        guide.reserve.kind === "form"
            ? {
                  ...guide.reserve,
                  path: said(t, `${base}.reserve.path`, guide.reserve.path),
                  add: said(t, `${base}.reserve.add`, guide.reserve.add),
                  save: said(t, `${base}.reserve.save`, guide.reserve.save),
                  fields: guide.reserve.fields.map((field, index) => ({
                      ...field,
                      label: said(t, `${base}.reserve.fields.${index}`, field.label)
                  }))
              }
            : {
                  ...guide.reserve,
                  path: said(t, `${base}.reserve.path`, guide.reserve.path),
                  action: said(t, `${base}.reserve.action`, guide.reserve.action)
              };
    return {
        ...guide,
        label: said(t, `${base}.label`, guide.label),
        signIn: said(t, `${base}.signIn`, guide.signIn),
        reserve,
        forwardPath: said(t, `${base}.forwardPath`, guide.forwardPath),
        forwardEnable: said(t, `${base}.forwardEnable`, guide.forwardEnable),
        remotePath: said(t, `${base}.remotePath`, guide.remotePath),
        caution: said(t, `${base}.caution`, guide.caution)
    };
}
