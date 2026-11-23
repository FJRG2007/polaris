/**
 * The functions the Rust core exports, identical in the Node binding
 * (`crates/polaris-core-node`) and the WebAssembly one (`crates/polaris-core-wasm`).
 * A loaded binding is checked against this list, so a stale build that lacks an
 * export is refused at load time instead of failing mid-call.
 */

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

export const BINDING_EXPORTS: readonly (keyof CoreBinding)[] = [
    "probeFnv1a32",
    "probeDecodeHex",
    "probePanic",
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
];

/** Copy the expected exports off a loaded module, refusing one that lacks any. */
export function pickBinding(loaded: unknown): CoreBinding {
    const source = loaded as Record<string, unknown> | null;
    const picked: Record<string, unknown> = {};
    for (const name of BINDING_EXPORTS) {
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
