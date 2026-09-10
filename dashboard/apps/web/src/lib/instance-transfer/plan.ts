/**
 * The order an instance's rows can be written back in.
 *
 * Every foreign key points at a row that has to exist first. The models are put in
 * an order where each comes after everything it requires; a reference that is
 * optional and would point forward - at its own model, or one later in the order -
 * is written empty and filled in once every row is in. A cycle made only of
 * required references cannot be written at all, and is refused by name.
 *
 * Pure: it reads the schema's own description (Prisma's DMMF) and nothing else,
 * so the order is tested without a database.
 */

export interface SchemaField {
    readonly name: string;
    readonly kind: string;
    readonly type: string;
    readonly isRequired: boolean;
    readonly isList: boolean;
    readonly isId?: boolean;
    readonly relationFromFields?: readonly string[];
}

export interface SchemaModel {
    readonly name: string;
    readonly dbName?: string | null;
    readonly fields: readonly SchemaField[];
    readonly primaryKey?: { readonly fields: readonly string[] } | null;
}

export interface WritePlan {
    /** Models in the order their rows are inserted. */
    readonly order: readonly string[];
    /** Per model, the foreign-key columns written empty first and set afterwards. */
    readonly deferred: ReadonlyMap<string, readonly string[]>;
}

/** The columns a model is identified by. */
export function keyFields(model: SchemaModel): string[] {
    const ids = model.fields.filter((field) => field.isId).map((field) => field.name);
    if (ids.length > 0) return ids;
    return [...(model.primaryKey?.fields ?? [])];
}

/** The references a model holds: the model pointed at, the columns, and whether they must be set. */
function referencesOf(model: SchemaModel) {
    return model.fields
        .filter((field) => field.kind === "object" && (field.relationFromFields?.length ?? 0) > 0)
        .map((field) => {
            const columns = [...(field.relationFromFields ?? [])];
            const required = columns.every(
                (column) =>
                    model.fields.find((candidate) => candidate.name === column)?.isRequired ?? false
            );
            return { target: field.type, columns, required };
        });
}

export function writePlan(models: readonly SchemaModel[]): WritePlan {
    const names = new Set(models.map((model) => model.name));
    const needs = new Map<string, Set<string>>();
    for (const model of models) {
        const required = new Set<string>();
        for (const reference of referencesOf(model)) {
            if (
                reference.required &&
                reference.target !== model.name &&
                names.has(reference.target)
            ) {
                required.add(reference.target);
            }
        }
        needs.set(model.name, required);
    }

    // Kahn's algorithm, taking models in schema order when several are ready, so
    // the order is stable between runs.
    const order: string[] = [];
    const placed = new Set<string>();
    while (order.length < models.length) {
        const ready = models.find(
            (model) =>
                !placed.has(model.name) &&
                [...(needs.get(model.name) ?? [])].every((need) => placed.has(need))
        );
        if (!ready) {
            const stuck = models
                .filter((model) => !placed.has(model.name))
                .map((model) => model.name);
            throw new Error(
                `These tables require each other and cannot be written back: ${stuck.join(", ")}`
            );
        }
        order.push(ready.name);
        placed.add(ready.name);
    }

    const position = new Map(order.map((name, index) => [name, index]));
    const deferred = new Map<string, string[]>();
    for (const model of models) {
        for (const reference of referencesOf(model)) {
            if (reference.required) {
                if (reference.target === model.name) {
                    throw new Error(
                        `${model.name} requires a row of its own kind, which cannot be written back`
                    );
                }
                continue;
            }
            const forward =
                reference.target === model.name ||
                (position.get(reference.target) ?? -1) > (position.get(model.name) ?? -1);
            if (forward)
                deferred.set(model.name, [
                    ...(deferred.get(model.name) ?? []),
                    ...reference.columns
                ]);
        }
    }
    return { order, deferred };
}
