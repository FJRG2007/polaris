/**
 * Backups, in Spanish.
 *
 * The services under `lib/backups` refuse in English and name kinds and
 * intervals in English, and reach the screen through `lib/backups/refusal-text`
 * and `lib/backups/words`: the English catalog is held to those sentences here,
 * and a sample of each is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { RESOURCE_KINDS_INFO } from "@/lib/backups/kinds";
import { BACKUP_EVERY_OPTIONS } from "@/lib/backups/policy";
import { everyLabel, kindInSentence, kindLabel, kindSummary } from "@/lib/backups/words";
import { backupRefusalText, KNOWN_BACKUP_REFUSALS } from "@/lib/backups/refusal-text";

const english = translatorFor("en-US", "backups");
const spanish = translatorFor("es-ES", "backups");

const SHAPED = [
    "A recovery key starts with polaris-backup-key: and has three parts",
    '"Offsite" names no storage connection',
    "Polaris cannot dump a cassandra database yet",
    "2 of the cluster's 3 masters answered, so no backup was taken: a copy of part of a cluster is not a backup of it.",
    "The dump failed inside db-1: pg_dump: error: connection refused",
    "Archiving /data failed: tar: short read",
    "Nothing was restored: a copy of what is there now could not be taken first (NAS: timed out).",
    "A game world cannot be put back from here - download it instead"
];

describe("the English that lib/backups writes", () => {
    it("comes back exactly as it went in", () => {
        for (const message of [...KNOWN_BACKUP_REFUSALS, ...SHAPED]) {
            expect(backupRefusalText(english, message)).toBe(message);
        }
    });

    it("names every kind and interval as the service does", () => {
        for (const info of Object.values(RESOURCE_KINDS_INFO)) {
            expect(kindLabel(english, info.kind)).toBe(info.label);
            expect(kindSummary(english, info.kind)).toBe(info.summary);
            expect(kindInSentence(english, info.kind)).toBe(info.label.toLowerCase());
        }
        for (const option of BACKUP_EVERY_OPTIONS) expect(everyLabel(english, option.value)).toBe(option.label);
    });
});

describe("in Spanish", () => {
    it("reads a refusal, exact or shaped", () => {
        expect(backupRefusalText(spanish, "That is the default destination. Make another one the default first.")).toBe(
            "Es el destino predeterminado. Haz antes predeterminado otro."
        );
        expect(backupRefusalText(spanish, "2 of the cluster's 3 masters answered, so no backup was taken: a copy of part of a cluster is not a backup of it.")).toBe(
            "Respondieron 2 de los 3 maestros del clúster, así que no se hizo copia: copiar parte de un clúster no es una copia de él."
        );
        expect(backupRefusalText(spanish, "A game world cannot be put back from here - download it instead")).toBe(
            "No se puede restaurar desde aquí un mundo de juego: descárgalo"
        );
    });

    it("keeps what a program printed as it printed it", () => {
        expect(backupRefusalText(spanish, "The dump failed inside db-1: pg_dump: error: connection refused")).toBe(
            "El volcado falló dentro de db-1: pg_dump: error: connection refused"
        );
        expect(backupRefusalText(spanish, "ECONNRESET")).toBe("ECONNRESET");
    });

    it("names kinds and intervals", () => {
        expect(kindLabel(spanish, "managed-database")).toBe("Base de datos");
        expect(everyLabel(spanish, "hourly")).not.toBe("Every hour");
        expect(kindLabel(spanish, "something-new", "Something new")).toBe("Something new");
    });
});
