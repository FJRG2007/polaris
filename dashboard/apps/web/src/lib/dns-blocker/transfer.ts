/**
 * The ad blocker's settings as one file, Pi-hole's Teleporter for this blocker:
 * written from what is saved, read back with the same schema a save is checked
 * with, and compared with what is saved so the screen can say what an import
 * changes before anything is applied.
 *
 * Pure and client-safe: the file never reaches the server until the form it
 * was loaded into is saved, and that save validates it again.
 */

import { z } from "zod";
import { dnsSettingsSchema, readDnsSettings, type DnsSettings } from "./settings";

export const DNS_EXPORT_FORMAT = "polaris-dns-blocker";
const DNS_EXPORT_VERSION = 1;

/** Larger than any settings the limits allow, small enough to read in a tab. */
export const DNS_IMPORT_MAX_BYTES = 2_000_000;

const envelopeSchema = z.object({
    format: z.literal(DNS_EXPORT_FORMAT),
    version: z.literal(DNS_EXPORT_VERSION),
    settings: z.record(z.string(), z.unknown())
});

export const DNS_SETTING_KEYS = Object.keys(dnsSettingsSchema.shape) as (keyof DnsSettings)[];

/** The file an export downloads. */
export function exportSettings(settings: DnsSettings, now = new Date()): string {
    return `${JSON.stringify(
        {
            format: DNS_EXPORT_FORMAT,
            version: DNS_EXPORT_VERSION,
            exportedAt: now.toISOString(),
            settings
        },
        null,
        2
    )}\n`;
}

/** The file's name, dated so several backups sort. */
export function exportFileName(now = new Date()): string {
    return `${DNS_EXPORT_FORMAT}-${now.toISOString().slice(0, 10)}.json`;
}

export type DnsImport =
    | {
          readonly ok: true;
          readonly settings: DnsSettings;
          /** The settings the import changes, in the schema's order. */
          readonly changed: readonly (keyof DnsSettings)[];
      }
    | {
          readonly ok: false;
          readonly error: "notJson" | "notExport" | "invalid";
          /** The settings that are wrong, when the file is an export. */
          readonly fields: readonly string[];
      };

/**
 * A file read against what is saved. A setting the file does not have (an
 * export from before it existed) keeps its saved value; one it has must be
 * valid exactly as a save would require, or the whole import is refused and
 * the wrong settings named.
 */
export function readImport(text: string, current: DnsSettings): DnsImport {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, error: "notJson", fields: [] };
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return { ok: false, error: "notExport", fields: [] };
    const given = Object.fromEntries(
        DNS_SETTING_KEYS.filter((key) => key in envelope.data.settings).map((key) => [
            key,
            envelope.data.settings[key]
        ])
    );
    const parsed = dnsSettingsSchema.safeParse({ ...current, ...given });
    if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))];
        return { ok: false, error: "invalid", fields: fields.filter(Boolean) };
    }
    // The same pass a stored row gets: lists and services no longer offered drop.
    const settings = readDnsSettings(parsed.data);
    const changed = DNS_SETTING_KEYS.filter(
        (key) => JSON.stringify(settings[key]) !== JSON.stringify(current[key])
    );
    return { ok: true, settings, changed };
}
