/**
 * The one search every list runs.
 *
 * The report: "the task search is far too permissive - I search for something
 * that is not there and many unrelated tasks come up." Every list handed its
 * rows to Fuse at a threshold of 0.3 to 0.4 over descriptions and bodies, which
 * accepts a third of the letters being wrong anywhere in a paragraph. What is
 * pinned here is the replacement: every word has to be there, a typo is forgiven
 * only when nothing matched as typed and only in the title, and the ranking puts
 * the title first.
 */

import { describe, expect, it } from "vitest";
import {
    isLiteralQuery,
    literalNeedle,
    normalizeSearchText,
    searchItems,
    type SearchField
} from "../src/search-text.js";

interface Task {
    readonly name: string;
    readonly description: string;
    readonly tags: readonly string[];
}

const task = (name: string, description = "", tags: readonly string[] = []): Task => ({
    name,
    description,
    tags
});

const TASK_FIELDS: readonly SearchField<Task>[] = [
    { text: (row) => row.name, weight: 3 },
    { text: (row) => row.description, weight: 1 },
    { text: (row) => row.tags, weight: 1 }
];

const TASKS: readonly Task[] = [
    task(
        "Migrar base de datos de producción",
        "Mover el clúster al nuevo servidor antes del viernes"
    ),
    task("Revisar la factura de enero", "Comprobar importes con contabilidad", ["finanzas"]),
    task("Canción para el vídeo de bienvenida", "Buscar una pista libre de derechos"),
    task("Bloquear el user agent de los scrapers", "Lista en el WAF", ["seguridad"]),
    task("Actualizar dependencias", "Revisar el changelog de Next antes de subir de versión"),
    task("Preparar la demo", "Ver https://github.com/diegosouzapw/OmniRoute antes de la llamada")
];

const names = (found: readonly Task[]): string[] => found.map((row) => row.name);
const search = (query: string): string[] => names(searchItems(TASKS, query, TASK_FIELDS));

describe("a query that matches nothing", () => {
    it.each([
        ["a word in no task at all", "kubernetes"],
        ["a word that shares letters with many", "despliegue"],
        ["one present word and one absent", "factura kubernetes"],
        ["a pasted address that is not there", "https://github.com/somebody/else"]
    ])("answers nothing for %s", (_, query) => {
        expect(search(query)).toEqual([]);
    });
});

describe("normalizing", () => {
    it.each([
        ["Canción", "cancion"],
        ["  Producción   DE  datos ", "produccion de datos"],
        ["user_agent", "user agent"],
        ["ÜBER", "uber"]
    ])("reads %j as %j", (value, expected) => {
        expect(normalizeSearchText(value)).toBe(expected);
    });

    it.each([
        ["cancion", "Canción para el vídeo de bienvenida"],
        ["CANCIÓN", "Canción para el vídeo de bienvenida"],
        ["produccion", "Migrar base de datos de producción"],
        ["cluster", "Migrar base de datos de producción"]
    ])("finds %j without its accents or its case", (query, expected) => {
        expect(search(query)).toEqual([expected]);
    });
});

describe("several words", () => {
    it("needs every one of them in the row", () => {
        expect(search("revisar factura")).toEqual(["Revisar la factura de enero"]);
    });

    it("lets them sit in different fields", () => {
        // "factura" in the name, "finanzas" a tag.
        expect(search("factura finanzas")).toEqual(["Revisar la factura de enero"]);
    });

    it("does not care which order they were typed in", () => {
        expect(search("agent user")).toEqual(["Bloquear el user agent de los scrapers"]);
    });

    it("ignores extra spaces between them", () => {
        expect(search("  revisar    factura ")).toEqual(["Revisar la factura de enero"]);
    });
});

describe("a typo", () => {
    it("is forgiven in a long word of the title when nothing matches as typed", () => {
        expect(search("producion")).toEqual(["Migrar base de datos de producción"]);
        expect(search("dependecias")).toEqual(["Actualizar dependencias"]);
    });

    it("survives two letters turned around, as one mistake", () => {
        // Fuse's Bitap also answered "Actualizar dependencias" here: "actua" is
        // "factrua" without its f and its r.
        expect(search("factrua")).toEqual(["Revisar la factura de enero"]);
        expect(names(searchItems([task("Diamond"), task("Dirt")], "dimaond", TASK_FIELDS))).toEqual(
            ["Diamond"]
        );
    });

    it("finds two words of the title typed as one", () => {
        expect(search("useragent")).toEqual(["Bloquear el user agent de los scrapers"]);
    });

    it("is one mistake in a short word, not two", () => {
        const rows = [task("Casa nueva"), task("Cosa vieja"), task("Caja fuerte")];
        expect(names(searchItems(rows, "cesa", TASK_FIELDS))).toEqual(["Casa nueva", "Cosa vieja"]);
        expect(names(searchItems(rows, "cxsx", TASK_FIELDS))).toEqual([]);
    });

    it("is not looked for while something matches as typed", () => {
        const rows = [task("Facturas pendientes"), task("Fracturas de la carcasa")];
        const found = names(searchItems(rows, "facturas", TASK_FIELDS));
        expect(found).toEqual(["Facturas pendientes"]);
    });

    it("is never forgiven in a description", () => {
        // "contabilidad" is only in a description, so a misspelling of it is not
        // a guess worth making.
        expect(search("contabilidat")).toEqual([]);
    });

    it("is not forgiven in a word too short to carry one", () => {
        expect(search("dmo")).toEqual([]);
    });

    it("still needs every other word as typed", () => {
        expect(search("producion kubernetes")).toEqual([]);
    });

    it("is not guessed at in a quoted query", () => {
        expect(search('"producion"')).toEqual([]);
    });
});

describe("a short query", () => {
    it("is every row with those letters in it", () => {
        expect(search("vi")).toEqual([
            "Canción para el vídeo de bienvenida",
            "Revisar la factura de enero",
            "Migrar base de datos de producción",
            "Actualizar dependencias"
        ]);
    });

    it("is every row, in the order given, when nothing has been typed", () => {
        expect(search("")).toEqual(names(TASKS));
        expect(search("   ")).toEqual(names(TASKS));
    });
});

describe("ranking", () => {
    const rows = [
        task("Notas de la reunión", "Hablar del deploy"),
        task("Redeploy del worker"),
        task("Deploy fallido en staging"),
        task("Deploy")
    ];
    const ranked = (query: string): string[] => names(searchItems(rows, query, TASK_FIELDS));

    it("puts the exact title, then a title word starting with it, then inside one, then the rest", () => {
        expect(ranked("deploy")).toEqual([
            "Deploy",
            "Deploy fallido en staging",
            "Redeploy del worker",
            "Notas de la reunión"
        ]);
    });

    it("keeps the order given between rows that matched equally well", () => {
        const twins = [task("Deploy A"), task("Deploy B"), task("Deploy C")];
        expect(names(searchItems(twins, "deploy", TASK_FIELDS))).toEqual([
            "Deploy A",
            "Deploy B",
            "Deploy C"
        ]);
    });

    it("lets a list break those ties its own way", () => {
        const twins = [task("Deploy A"), task("Deploy B"), task("Deploy C")];
        const found = searchItems(twins, "deploy", TASK_FIELDS, {
            tieBreak: (left, right) => right.name.localeCompare(left.name)
        });
        expect(names(found)).toEqual(["Deploy C", "Deploy B", "Deploy A"]);
    });

    it("ranks a word in a heavier field above one in a lighter field", () => {
        const fields: readonly SearchField<Task>[] = [
            { text: (row) => row.name, weight: 3 },
            { text: (row) => row.tags, weight: 2 },
            { text: (row) => row.description, weight: 1 }
        ];
        const spread = [task("Uno", "urgente"), task("Dos", "", ["urgente"])];
        expect(names(searchItems(spread, "urgente", fields))).toEqual(["Dos", "Uno"]);
    });

    it("stops at the limit", () => {
        expect(names(searchItems(rows, "deploy", TASK_FIELDS, { limit: 2 }))).toEqual([
            "Deploy",
            "Deploy fallido en staging"
        ]);
    });
});

describe("a query that names one exact thing", () => {
    it("finds the row that carries the value", () => {
        expect(search("https://github.com/diegosouzapw/OmniRoute")).toEqual(["Preparar la demo"]);
    });

    it("is matched as one piece when it is quoted", () => {
        expect(search('"user agent"')).toEqual(["Bloquear el user agent de los scrapers"]);
        expect(search('"agent user"')).toEqual([]);
    });

    it("is matched as one piece when it is pasted unquoted", () => {
        const rows = [
            task("Archivar sesiones", "user sessions, then the archive for 2024"),
            task("Limpiar tablas", "Vaciar user_sessions_archive_2024 antes del viernes")
        ];
        expect(names(searchItems(rows, "user_sessions_archive_2024", TASK_FIELDS))).toEqual([
            "Limpiar tablas"
        ]);
        expect(names(searchItems(rows, "src/lib user", TASK_FIELDS))).toEqual([]);
    });

    it.each([
        "https://github.com/diegosouzapw/OmniRoute",
        "mailto:someone@example.test",
        "src/lib/telemetry",
        "@fjrg2007",
        "#4821",
        "9f3a1c2e4b5d4f0a8c7b6e5d4c3b2a19",
        '"user agent"'
    ])("is recognised in %j", (query) => {
        expect(isLiteralQuery(query)).toBe(true);
    });

    it.each([
        "useragent",
        "restart the relay",
        "ENG-42",
        "camera",
        "a",
        "/",
        "the deploy that keeps falling over on tuesday"
    ])("is not read into %j", (query) => {
        expect(isLiteralQuery(query)).toBe(false);
    });

    it("is looked for without its quotes", () => {
        expect(literalNeedle('"user agent"')).toBe("user agent");
    });
});

describe("rows that are not objects", () => {
    it("are searched all the same", () => {
        const words = ["manzana", "plátano", "pera"];
        const fields: readonly SearchField<string>[] = [{ text: (word) => word }];
        expect(searchItems(words, "platano", fields)).toEqual(["plátano"]);
        expect(searchItems(words, "kiwi", fields)).toEqual([]);
    });
});
