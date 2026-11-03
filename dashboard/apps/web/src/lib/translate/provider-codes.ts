/**
 * Translate's language codes (short BCP 47: `en`, `pt-BR`, `zh-Hans`) spelled
 * the way each paid provider wants them. DeepL: upper case, English and
 * Portuguese targets need a variant, and a source never has one. Google:
 * `zh-CN` and `zh-TW` for the two scripts.
 */

/** DeepL's spelling of a target: upper case, and English and Portuguese need a variant. */
export function deeplTarget(code: string): string {
    const upper = code.toUpperCase();
    if (upper === "EN") return "EN-US";
    if (upper === "PT") return "PT-PT";
    if (upper === "ZH") return "ZH-HANS";
    return upper;
}

/** DeepL's spelling of a source: the language alone, never a variant. */
export function deeplSource(code: string): string {
    return code.split("-")[0]!.toUpperCase();
}

/** Google's spelling: `zh-CN`/`zh-TW` for the two scripts, everything else as is. */
export function googleCode(code: string): string {
    if (code === "zh-Hans" || code === "zh") return "zh-CN";
    if (code === "zh-Hant") return "zh-TW";
    return code;
}
