import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "arktype";
import { fileTypeFromBuffer } from "file-type";
import { apiFetch } from "../utils/apiFetch.ts";
import { log } from "../utils/cli.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

const UploadFileParams = type({
  path: type.string.describe("absolute path to file to upload"),
});

export function UploadFileTool(ctx: ToolContext) {
  return tool({
    name: "upload_file",
    mutates: true,
    description:
      "upload a file to get a permanent public URL. use for screenshots, artifacts, or any files you want to reference in PRs/comments. max 10MB, images/text/archives allowed. when embedding uploaded images in comments or PR bodies, always use markdown image syntax: ![description](url)",
    parameters: UploadFileParams,
    execute: execute(async (params) => {
      // read file from disk eagerly on purpose to avoid its content being changed by the time it's uploaded
      const buffer = fs.readFileSync(params.path);
      const filename = path.basename(params.path);
      const contentLength = buffer.length;

      const fileType = await fileTypeFromBuffer(buffer);
      const contentType = fileType?.mime || "application/octet-stream";

      const response = await apiFetch({
        path: "/api/upload/signed-url",
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filename,
          contentType,
          contentLength,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`failed to get upload URL: ${error}`);
      }

      const { uploadUrl, publicUrl, contentDisposition } = (await response.json()) as {
        uploadUrl: string;
        publicUrl: string;
        contentDisposition?: string | undefined;
      };

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          // should be set automatically, but given this header is signed it's better to be explicit
          "Content-Length": String(contentLength),
          ...(contentDisposition && { "Content-Disposition": contentDisposition }),
        },
        body: buffer,
      });

      if (!uploadResponse.ok) {
        throw new Error(`failed to upload file: ${uploadResponse.statusText}`);
      }

      log.info(`» uploaded file ${publicUrl}`);

      return { success: true, publicUrl, filename, contentLength, contentType };
    }),
  });
}
