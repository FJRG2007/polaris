/**
 * Generate a SQLite variant of the Prisma schema for local, container-free dev.
 * The models are already SQLite-portable, so this only swaps the datasource
 * provider; keeping it generated (rather than a second hand-maintained file)
 * means the dev schema can never drift from the Postgres source of truth.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, "..", "packages", "db", "prisma");
const source = readFileSync(join(prismaDir, "schema.prisma"), "utf8");

const swapped = source.replace(
    /datasource db \{[^}]*\}/,
    'datasource db {\n    provider = "sqlite"\n    url      = env("POLARIS_DATABASE_URL")\n}'
);

const banner = "// AUTO-GENERATED from schema.prisma by scripts/gen-sqlite-schema.mjs - do not edit.\n";
writeFileSync(join(prismaDir, "schema.sqlite.prisma"), banner + swapped);
console.log("Wrote packages/db/prisma/schema.sqlite.prisma");
