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
import type { SVGProps } from "react";
import { Database } from "lucide-react";
import { dbEngineLabel, type DbEngine } from "@polaris/core";
import { MariaDbMark, MongoDbMark, MySqlMark, PostgresMark, RedisMark } from "./brand-icons";

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

const BRANDS: Partial<Record<DbEngine, EngineBrand>> = {
    postgres: { Mark: PostgresMark, color: "#4169E1" },
    mysql: { Mark: MySqlMark, color: "#4479A1" },
    mariadb: { Mark: MariaDbMark, color: "#003545", themedClass: "db-mark-mariadb" },
    mongo: { Mark: MongoDbMark, color: "#47A248" },
    redis: { Mark: RedisMark, color: "#FF4438" }
};

/** The engine's mark on its tinted chip. Falls back to a generic database glyph
 *  for an engine this build does not know, so a row still renders. */
export function DbEngineIcon({ engine, className }: { engine: string; className?: string }) {
    const brand = BRANDS[engine as DbEngine];
    if (!brand) {
        return (
            <span
                className={cn(
                    "grid shrink-0 place-items-center rounded-md border border-border bg-surface text-accent",
                    className ?? "size-7"
                )}
            >
                <Database className="size-[55%]" />
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
