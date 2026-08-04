import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { Ajv } from "ajv";
import { type } from "arktype";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const SetOutputParams = type({
  value: type.string.describe("the output value to expose as a GitHub Action output"),
});

type JsonSchema = Record<string, unknown>;

function jsonSchemaToStandardSchema({
  $schema: _,
  ...jsonSchema
}: JsonSchema): StandardJSONSchemaV1<any> & StandardSchemaV1<any> {
  const ajv = new Ajv();
  const validate = ajv.compile(jsonSchema);

  return {
    "~standard": {
      version: 1,
      vendor: "json-schema",
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
      validate(input: unknown) {
        if (validate(input)) {
          return { value: input };
        }
        return {
          issues: (validate.errors ?? []).map((err) => ({
            message: `${err.instancePath || "/"}: ${err.message ?? "validation error"}`,
            path: err.instancePath ? err.instancePath.split("/").filter(Boolean) : [],
          })),
        };
      },
    },
  };
}

function storeOutput(ctx: ToolContext, value: string) {
  ctx.toolState.output = value;
  return { success: true };
}

export function SetOutputTool(ctx: ToolContext, outputSchema?: JsonSchema) {
  if (outputSchema) {
    return tool({
      name: "set_output",
      mutates: true,
      description:
        "Set the structured action output. You MUST call this tool before finishing - the output is required. Pass the output object directly as the tool arguments (no wrapping needed).",
      parameters: jsonSchemaToStandardSchema(outputSchema),
      execute: execute(async (params) => {
        return storeOutput(ctx, JSON.stringify(params));
      }),
    });
  }

  return tool({
    name: "set_output",
    mutates: true,
    description:
      "Set the action output. Exposes the value as the 'result' GitHub Action output for downstream workflow steps. Do NOT use this for progress reporting - use report_progress instead.",
    parameters: SetOutputParams,
    execute: execute(async (params) => {
      return storeOutput(ctx, params.value);
    }),
  });
}
