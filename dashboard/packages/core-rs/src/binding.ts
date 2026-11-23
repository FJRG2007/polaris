/**
 * The functions the Rust core exports: all of them in the Node binding
 * (`crates/polaris-core-node`), and in the WebAssembly one
 * (`crates/polaris-core-wasm`) those of every domain not marked `"wasm": false`
 * in `domains.json`. A loaded binding is checked against its target's list, so
 * a stale build that lacks an export is refused at load time instead of
 * failing mid-call.
 */

import { DOMAINS, type DomainName } from "./registry";

export interface CoreBinding {
    probeFnv1a32(text: string): number;
    probeDecodeHex(hex: string): Uint8Array;
    probePanic(): void;
    phoneCountries(): string[];
    phoneIsCountry(code: string | null | undefined): boolean;
    phoneCallingCode(country: string): string | null | undefined;
    phoneMainCountry(callingCode: string): string | null | undefined;
    phoneToE164(value: string, country: string | null | undefined): string | null | undefined;
    phoneCountryOf(value: string): string | null | undefined;
    phoneSplit(value: string): { country?: string | null; national?: string | null; start: number; end: number };
    phoneFormatAsTyped(value: string, country: string | null | undefined): string;
    phoneFormatInternational(value: string): string | null | undefined;
    phoneCountryFromRegions(regions: (string | null)[]): string | null | undefined;
}

/** Each domain's exports, so a target that does not serve a domain can leave them out. */
export const DOMAIN_EXPORTS: Readonly<Record<DomainName, readonly (keyof CoreBinding)[]>> = {
    probe: ["probeFnv1a32", "probeDecodeHex", "probePanic"],
    phone: [
        "phoneCountries",
        "phoneIsCountry",
        "phoneCallingCode",
        "phoneMainCountry",
        "phoneToE164",
        "phoneCountryOf",
        "phoneSplit",
        "phoneFormatAsTyped",
        "phoneFormatInternational",
        "phoneCountryFromRegions"
    ]
};

/** Where a binding runs: the Node addon serves every domain, WebAssembly only those it is built with. */
export type BindingTarget = "napi" | "wasm";

/** Whether `target` serves `domain` (the WebAssembly build leaves out a domain marked `"wasm": false`). */
export function serves(target: BindingTarget, domain: DomainName): boolean {
    return target === "napi" || DOMAINS[domain].wasm !== false;
}

/** Every export a `target` binding must have. */
export function bindingExports(target: BindingTarget): (keyof CoreBinding)[] {
    return (Object.keys(DOMAIN_EXPORTS) as DomainName[]).filter((domain) => serves(target, domain)).flatMap((domain) => DOMAIN_EXPORTS[domain]);
}

/** Every export of the Node binding, which serves all domains. */
export const BINDING_EXPORTS: readonly (keyof CoreBinding)[] = bindingExports("napi");

/**
 * Copy the exports `target` must have off a loaded module, refusing one that
 * lacks any. A WebAssembly binding comes back without the exports of the
 * domains it does not serve; the facade answers those with TypeScript.
 */
export function pickBinding(loaded: unknown, target: BindingTarget = "napi"): CoreBinding {
    const source = loaded as Record<string, unknown> | null;
    const picked: Record<string, unknown> = {};
    for (const name of bindingExports(target)) {
        const fn = source?.[name];
        if (typeof fn !== "function") throw new Error(`binding has no ${name} export`);
        picked[name] = fn;
    }
    return picked as unknown as CoreBinding;
}

/** Thrown by a source whose binding file is simply not there (as opposed to broken). */
export class BindingMissingError extends Error {
    override name = "BindingMissingError";
}
