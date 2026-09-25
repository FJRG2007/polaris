import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "packages", "db", "prisma");

const source = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

const swapped = source
    .replace(
        /datasource db \{[^}]*\}/,
        'datasource db {\n    provider = "sqlite"\n    url      = env("POLARIS_DATABASE_URL")\n}'
    )
    // SQLite has no native uuid type; drop the Postgres-only @db.Uuid mapping.
    .replace(/ @db\.Uuid/g, "")
    // SQLite does not support primitive lists such as String[].
    // Store the list as JSON in the local SQLite database.
    .replace(/\bspamReasons\s+String\[\]/g, "spamReasons Json")
    // SQLite does not support default values for JSON columns.
    .replace(/@default\(\{\}\)/g, '@default("{}")')
    // SQLite does not support default values for JSON columns.
    .replace(/\bcounted\s+Json\s+@default\("\{\}"\)/g, "counted Json");

// enigma:allow-sqlite - this variant is never the deployed datastore.
const banner = `// AUTO-GENERATED from schema.prisma by scripts/gen-sqlite-schema.mjs - do not edit.
// enigma:allow-sqlite - container-free local dev only; Polaris deploys on Postgres.

`;

writeFileSync(
    join(prismaDir, "schema.sqlite.prisma"),
    banner + swapped
);

console.log("Wrote packages/db/prisma/schema.sqlite.prisma");