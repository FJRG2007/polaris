import { z } from "zod";

/**
 * Where DMARC reports should go, for a domain Polaris does not receive them for.
 *
 * One rule for the fix dialog and the server: trimmed and lowercased first, then
 * it has to be an email address - the `mailto:` a DMARC record's `rua` names.
 */
export function normalizeReportTo(value: string): string {
    return value.trim().toLowerCase();
}

export const reportToSchema = z.preprocess(
    (value) => (typeof value === "string" ? normalizeReportTo(value) : value),
    z.string().email().max(254).nullable().optional()
);
