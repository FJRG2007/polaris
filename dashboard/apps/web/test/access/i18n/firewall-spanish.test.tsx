/**
 * The firewall, in Spanish.
 *
 * The managed rules and the jails are written in @polaris/core, in English, and
 * the screen says them from the catalog - so the English catalog is held to core's
 * own text here, word for word, and a rule core adds before the catalog knows it
 * keeps its English rather than showing keys. The rest is what a reader sees
 * first: a managed rule opened, and a rule written as a sentence.
 */

import { describe, expect, it } from "vitest";
import { withMessages } from "../../setup/i18n";
import { translatorFor } from "@/lib/i18n/translate";
import { renderToStaticMarkup } from "react-dom/server";
import { ruleDescription } from "@/app/(app)/apps/firewall/rule-language";
import { ManagedRulePage } from "@/app/(app)/apps/firewall/managed-rule-page";
import { localizeJail, localizeManaged } from "@/app/(app)/apps/firewall/waf-words";
import { DEFAULT_WAF_JAILS, WAF_MANAGED_RULES, wafManagedRule, type WafManagedRule } from "@polaris/core";

const english = translatorFor("en-US", "firewall");
const spanish = translatorFor("es-ES", "firewall");

describe("core's rules, through the catalog", () => {
    it("reads exactly as core writes them in English", () => {
        for (const rule of WAF_MANAGED_RULES) expect(localizeManaged(rule, english)).toEqual(rule);
        for (const jail of DEFAULT_WAF_JAILS) expect(localizeJail(jail, english)).toEqual(jail);
    });

    it("keeps a rule the catalog does not know in its own words", () => {
        const unknown = { ...WAF_MANAGED_RULES[0]!, id: "brand-new" } as WafManagedRule;
        expect(localizeManaged(unknown, spanish)).toEqual(unknown);
    });

    it("says every rule and jail in Spanish", () => {
        for (const rule of WAF_MANAGED_RULES) {
            const said = localizeManaged(rule, spanish);
            expect(said.label).not.toBe(rule.label);
            expect(said.description).not.toBe(rule.description);
        }
        const probes = DEFAULT_WAF_JAILS.find((jail) => jail.id === "probes")!;
        expect(localizeJail(probes, spanish).label).toBe("Sondeo de exploits");
    });
});

describe("a managed rule, opened in Spanish", () => {
    it("names what it does and what it matches", () => {
        const rule = localizeManaged(wafManagedRule("xss")!, spanish);
        const markup = renderToStaticMarkup(
            withMessages(
                <ManagedRulePage
                    rule={rule}
                    enabled
                    onBack={() => {}}
                    onToggle={() => {}}
                    onCreateException={() => {}}
                />,
                "es-ES"
            )
        );
        expect(markup).toContain("Bloquear cross-site scripting");
        expect(markup).toContain("Qué detecta");
        expect(markup).toContain("Crear una excepción");
        // The markup a signature names is passed in, not read as a tag.
        expect(markup).toContain("como &lt;b&gt; no lo es");
    });
});

describe("a rule as a sentence", () => {
    it("reads in Spanish", () => {
        expect(
            ruleDescription(
                { conditions: [{ field: "path", operator: "starts_with", values: ["/wp-admin", "/a", "/b", "/c"] }] },
                spanish
            )
        ).toBe("Ruta empieza por /wp-admin, /a, /b y 1 más");
    });
});
