/**
 * The domain fields an administrator types on the Domains page, each as one
 * normalizer and one check that the field runs as it is typed and the save runs
 * again on the server. Pure and client-safe.
 *
 * Every field may be left empty, which clears it; anything else has to be the kind of
 * name the field asks for - and something typed that normalizes away to nothing is
 * refused rather than saved as a cleared field. Before this a sharing domain of
 * `////` was stored as typed, and every link Polaris handed out after that read
 * `https://`.
 */

import { z } from "zod";
import { isDnsLabel, isDomainName, normalizeHostInput, normalizeSiteAddress } from "@polaris/core";

/** A field's value as it will be stored, and whether it may be. */
export interface DomainFieldCheck {
    value: string;
    ok: boolean;
}

/** The app or sharing domain: `polaris.example.com`, an IP, optionally with a port. */
export function siteAddressField(typed: string): DomainFieldCheck {
    if (typed.trim() === "") return { value: "", ok: true };
    const value = normalizeSiteAddress(typed);
    return value === null ? { value: typed.trim(), ok: false } : { value, ok: true };
}

/** The DuckDNS name, which the operator often pastes whole: `mypolaris.duckdns.org`. */
export function duckSubdomainField(typed: string): DomainFieldCheck {
    if (typed.trim() === "") return { value: "", ok: true };
    const value = normalizeHostInput(typed).replace(/\.duckdns\.org$/, "");
    return { value, ok: isDnsLabel(value) };
}

/** A base domain other names are made under (`apps.example.com`), `*.` optional. */
export function baseDomainField(typed: string): DomainFieldCheck {
    if (typed.trim() === "") return { value: "", ok: true };
    const value = normalizeHostInput(typed).replace(/^\*\./, "");
    return { value, ok: isDomainName(value) };
}

/** A schema for one field: refuses what its check refuses, stores what it normalizes. */
function fieldSchema(check: (typed: string) => DomainFieldCheck) {
    return z
        .string()
        .max(512)
        .transform((typed, ctx) => {
            const checked = check(typed);
            if (!checked.ok) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid" });
                return z.NEVER;
            }
            return checked.value;
        });
}

export const siteAddressSchema = fieldSchema(siteAddressField);
export const duckSubdomainSchema = fieldSchema(duckSubdomainField);
export const baseDomainSchema = fieldSchema(baseDomainField);
