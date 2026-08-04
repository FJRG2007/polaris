import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Tool } from "fastmcp";
import type { ToolContext } from "./server.ts";

// ── gemini schema sanitizer ────────────────────────────────────────────────────
//
// gemini's generateContent API expects an OpenAPI 3.0 Schema subset, not full
// JSON Schema. arktype 2.x emits constructs that gemini rejects with errors like:
//   - "parameters.<field>.enum: only allowed for STRING type"
//   - "functionDeclaration parameters.<field> schema didn't specify the schema type field"
//   - "anyOf must be the only field in a schema node"
//
// transforms applied here:
//   1. add `type: "string"` to enum-only schemas. arktype emits string literal
//      unions as `{enum: ["a","b"]}` without a `type` field - gemini requires
//      the type declaration for any non-object schema.
//   2. collapse `{anyOf: [{enum:["a"]}, {enum:["b"]}]}` (older arktype form)
//      into `{type:"string", enum:[...]}`. also handles `{const:"a"}` branches.
//   3. when `anyOf` / `oneOf` can't be collapsed, strip sibling fields (`type`,
//      `description`, `items`, etc.) - gemini rejects `anyOf` alongside any
//      peer keywords. see opencode #14659.
//   4. drop `$schema` metadata and rename `$defs` → `definitions` (draft-07
//      compatibility; gemini doesn't understand either).
//
// gating: `isGeminiRouted()` detects gemini-targeted traffic so other
// providers continue to see the original (untransformed) schema.
//
// delivery: fastmcp (3.x) uses `xsschema.toJsonSchema()` which reads
// `schema["~standard"].jsonSchema.input({target:"draft-07"})` when present
// (arktype 2.x exposes this). we proxy the whole `~standard` chain so our
// transform runs regardless of which path xsschema takes.

function parseStringEnumBranch(item: unknown): { values: string[] } | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    const strings = record.enum.filter((v): v is string => typeof v === "string");
    return strings.length === record.enum.length && strings.length > 0 ? { values: strings } : null;
  }
  if (typeof record.const === "string") {
    return { values: [record.const] };
  }
  return null;
}

function collapseStringUnion(branches: unknown[]): { type: "string"; enum: string[] } | null {
  const values: string[] = [];
  for (const item of branches) {
    const parsed = parseStringEnumBranch(item);
    if (!parsed) return null;
    values.push(...parsed.values);
  }
  if (values.length === 0) return null;
  return { type: "string", enum: [...new Set(values)] };
}

/**
 * Recursively transform a JSON schema to gemini's stricter subset.
 * See module header for the exact transforms applied.
 */
export function sanitizeForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini);

  const source = schema as Record<string, unknown>;

  // case 1: enum-only string union → add `type: "string"`.
  // arktype emits `type: "'A' | 'B'"` as `{enum: ["A","B"]}` without a type.
  if (Array.isArray(source.enum) && typeof source.type !== "string") {
    const allStrings = source.enum.every((v) => typeof v === "string");
    if (allStrings) {
      const result: Record<string, unknown> = { type: "string", enum: source.enum };
      if (typeof source.description === "string") result.description = source.description;
      return result;
    }
  }

  // case 2: collapsible string-enum union (older arktype form)
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const branches = source[unionKey];
    if (Array.isArray(branches) && branches.length > 0) {
      const collapsed = collapseStringUnion(branches);
      if (collapsed) {
        const result: Record<string, unknown> = { ...collapsed };
        if (typeof source.description === "string") result.description = source.description;
        return result;
      }
    }
  }

  // case 3: non-collapsible anyOf/oneOf → strip sibling fields (gemini rule)
  if (Array.isArray(source.anyOf) || Array.isArray(source.oneOf)) {
    const result: Record<string, unknown> = {};
    if (Array.isArray(source.anyOf)) result.anyOf = source.anyOf.map(sanitizeForGemini);
    if (Array.isArray(source.oneOf)) result.oneOf = source.oneOf.map(sanitizeForGemini);
    return result;
  }

  // case 4: generic pass - drop $schema, rename $defs, recurse
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema") continue;
    if (key === "$defs") {
      sanitized.definitions = sanitizeForGemini(value);
      continue;
    }
    sanitized[key] = sanitizeForGemini(value);
  }
  return sanitized;
}

// ── delivery mechanism ─────────────────────────────────────────────────────────
//
// fastmcp 3.x resolves the JSON schema via xsschema, which takes two paths:
//   path A: `schema["~standard"].jsonSchema.input({target:"draft-07"})` when
//           the StandardJSONSchemaV1 extension is present (arktype 2.x).
//   path B: `schema.toJsonSchema()` via a vendor-dispatched function (older
//           arktype, other vendors).
//
// we proxy both entry points so the transform runs regardless of which path
// xsschema picks.

function wrapJsonSchemaProducer<T extends object>(producer: T): T {
  return new Proxy(producer, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === "input" || prop === "output") && typeof value === "function") {
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => sanitizeForGemini(fn.apply(target, args));
      }
      return value;
    },
  });
}

function wrapStandard<T extends object>(standard: T): T {
  return new Proxy(standard, {
    get(target, prop, receiver) {
      if (prop === "jsonSchema") {
        const value = Reflect.get(target, prop, receiver);
        if (value && typeof value === "object") {
          return wrapJsonSchemaProducer(value as object);
        }
        return value;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function wrapSchemaForGemini(schema: StandardSchemaV1<any>): StandardSchemaV1<any> {
  return new Proxy(schema, {
    get(target, prop, receiver) {
      if (prop === "~standard") {
        const value = Reflect.get(target, prop, receiver);
        if (value && typeof value === "object") {
          return wrapStandard(value as object);
        }
        return value;
      }
      if (prop === "toJsonSchema") {
        const method = Reflect.get(target, prop, receiver);
        if (typeof method === "function") {
          return () => sanitizeForGemini((method as (...args: unknown[]) => unknown).call(target));
        }
        return method;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as StandardSchemaV1<any>;
}

export function sanitizeToolForGemini<T extends Tool<any, any>>(tool: T): T {
  if (!tool.parameters) return tool;
  return { ...tool, parameters: wrapSchemaForGemini(tool.parameters) } as T;
}

/**
 * true when the effective upstream model is - or might become - google
 * generative language API traffic. matches:
 *   - direct `google/*`, opencode `opencode/gemini-*`, openrouter
 *     `openrouter/google/gemini-*` (slug substring "gemini" wins).
 *   - any unresolved specifier: `undefined`, `"auto"`, or a slug that
 *     didn't map through the alias registry (no `provider/` prefix).
 *     these flow through the agent's own auto-select, which may land
 *     on gemini *after* the MCP server has already registered tools -
 *     at which point sanitization is too late to apply. erring on the
 *     side of sanitizing is safe: cases 1 + 2 are universally
 *     compatible JSON-Schema normalizations (enum-only → typed string,
 *     collapsible const-unions → string enum); case 3 is gemini-
 *     specific but only fires on non-collapsible unions, which arktype
 *     does not emit for our current tool schemas. see issue #676 for
 *     the prod failure that motivated this widening.
 */
export function isGeminiRouted(ctx: ToolContext): boolean {
  const effective = ctx.payload.proxyModel ?? ctx.resolvedModel ?? ctx.payload.model;
  if (!effective) return true;
  const normalized = effective.toLowerCase();
  if (normalized.includes("gemini")) return true;
  // every concrete model resolved through the registry carries a
  // `provider/` prefix (e.g. "anthropic/claude-opus-4-7"). anything
  // without a slash is either the literal `"auto"` alias or an
  // unrecognized slug that resolveModel logged a warning for - both
  // route through the agent's late auto-select, which may pick gemini.
  if (!normalized.includes("/")) return true;
  return false;
}
