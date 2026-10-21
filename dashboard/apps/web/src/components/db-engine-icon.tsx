/**
 * A database engine, shown the way the project shows itself: its own mark in its
 * own brand color, on a chip tinted with that same color.
 *
 * The chip is what makes brand fidelity possible here. These marks are
 * single-color, and one of them (MariaDB, #003545) is nearly black, so placing
 * it straight onto a dark surface would hide it. Sitting it on a low-opacity
 * wash of its own color gives every engine the same readable contrast in both
 * themes without recoloring any of them - except MariaDB in dark, which switches
 * to the project's own white variant rather than to an invented tint.
 */

import { cn } from "@polaris/ui";
import type { JSX, SVGProps } from "react";
import { Archive, Database } from "lucide-react";
import { dbEngineLabel, isStorageEngine } from "@polaris/core";
import * as marks from "./brand-icons";

interface EngineBrand {
    readonly Mark: (props: SVGProps<SVGSVGElement>) => JSX.Element;
    /** The project's official color, from its own brand assets. */
    readonly color: string;
    /** Set when the mark is too dark to read on the dark theme's surfaces. The
     *  class flips it to the project's own white variant there and back to the
     *  brand color under `:root.light`; it therefore takes the place of the
     *  inline color rather than sitting beside it, which would always lose. */
    readonly themedClass?: string;
}

// Typesense publishes only a wordmark, which does not fit a square chip, so it
// keeps the generic glyph rather than a mark drawn to look like theirs.
const BRANDS: Readonly<Record<string, EngineBrand>> = {
    postgres: { Mark: marks.PostgresMark, color: "#4169E1" },
    mysql: { Mark: marks.MySqlMark, color: "#4479A1" },
    mariadb: { Mark: marks.MariaDbMark, color: "#003545", themedClass: "db-mark-mariadb" },
    mongo: { Mark: marks.MongoDbMark, color: "#47A248" },
    redis: { Mark: marks.RedisMark, color: "#FF4438" },
    minio: { Mark: marks.MinioMark, color: "#C72E49" },
    meilisearch: { Mark: marks.MeilisearchMark, color: "#FF5CAA" },
    clickhouse: { Mark: marks.ClickHouseMark, color: "#FFCC01", themedClass: "db-mark-clickhouse" },
    influxdb: { Mark: marks.InfluxDbMark, color: "#22ADF6" },
    couchdb: { Mark: marks.CouchDbMark, color: "#E42528" },
    kafka: { Mark: marks.KafkaMark, color: "#231F20", themedClass: "db-mark-kafka" },
    rabbitmq: { Mark: marks.RabbitMqMark, color: "#FF6600" }
};

/**
 * The cloud providers' marks. A provider that is a product of an engine's own
 * company wears the engine's mark; Confluent, Aiven, IBM Cloudant, CloudAMQP and
 * Typesense Cloud are not in any open icon set and have no square mark in a
 * press kit we could source, so they show the generic glyph.
 */
const PROVIDER_BRANDS: Readonly<Record<string, EngineBrand>> = {
    // The AWS letters are currentColor (ink on light, white on dark); the smile
    // keeps its own orange, which also tints the chip.
    "aws-s3": { Mark: marks.AwsMark, color: "#FF9900", themedClass: "text-foreground" },
    "cloudflare-r2": { Mark: marks.CloudflareMark, color: "#F38020" },
    "backblaze-b2": { Mark: marks.BackblazeMark, color: "#E21E29" },
    "meilisearch-cloud": BRANDS.meilisearch!,
    "clickhouse-cloud": BRANDS.clickhouse!,
    "influxdb-cloud": BRANDS.influxdb!
};

/** The engine's mark on its tinted chip. An object store is shown as what it is
 *  to the reader - storage, not a product - and an engine this build does not
 *  know as a generic database, so a row still renders. */
export function DbEngineIcon({ engine, className }: { engine: string; className?: string }) {
    return (
        <BrandChip brand={BRANDS[engine]} storage={isStorageEngine(engine)} className={className} />
    );
}

/** Where a data engine lives: a cloud provider's mark on the same chip. */
export function CloudProviderIcon({
    provider,
    className
}: {
    provider: string;
    className?: string;
}) {
    return <BrandChip brand={PROVIDER_BRANDS[provider]} storage={false} className={className} />;
}

function BrandChip({
    brand,
    storage,
    className
}: {
    brand: EngineBrand | undefined;
    storage: boolean;
    className?: string;
}) {
    if (!brand) {
        const Glyph = storage ? Archive : Database;
        return (
            <span
                className={cn(
                    "grid shrink-0 place-items-center rounded-md border border-border bg-surface text-accent",
                    className ?? "size-7"
                )}
            >
                <Glyph className="size-[55%]" />
            </span>
        );
    }
    const { Mark } = brand;
    return (
        <span
            aria-hidden="true"
            className={cn("grid shrink-0 place-items-center rounded-md", className ?? "size-7")}
            style={{ backgroundColor: `${brand.color}1f` }}
        >
            <Mark
                className={cn("size-[62%]", brand.themedClass)}
                style={brand.themedClass ? undefined : { color: brand.color }}
            />
        </span>
    );
}

/** The mark and the engine's own name for itself, the pair used in lists and
 *  pickers where "postgres" would otherwise appear raw. */
export function DbEngineLabel({ engine, className }: { engine: string; className?: string }) {
    return (
        <span className={cn("flex min-w-0 items-center gap-2", className)}>
            <DbEngineIcon engine={engine} className="size-5" />
            <span className="truncate">{dbEngineLabel(engine)}</span>
        </span>
    );
}
