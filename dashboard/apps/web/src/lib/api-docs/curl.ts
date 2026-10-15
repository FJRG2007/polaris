/**
 * A curl command for one documented call. No imports, so the reference screen
 * builds it in the browser on the instance's own address.
 */

export interface CurlInput {
    method: string;
    /** OpenAPI path template; each `{name}` is shown as `<name>`. */
    path: string;
    /** A JSON body to send, already serialized. */
    bodyExample?: string | null;
    /** The content type of a raw-file body. */
    binaryType?: string | null;
}

export function curlCommand(input: CurlInput, baseUrl: string, key: string): string {
    const path = input.path.replace(/\{([^}]+)\}/g, (_, name: string) => `<${name}>`);
    const lines = [
        `curl -X ${input.method} "${baseUrl}${path}"`,
        `  -H "Authorization: Bearer ${key}"`
    ];
    if (input.bodyExample) {
        lines.push('  -H "Content-Type: application/json"', `  -d '${input.bodyExample}'`);
    } else if (input.binaryType) {
        lines.push(`  -H "Content-Type: ${input.binaryType}"`, "  --data-binary @image.tar.gz");
    }
    return lines.join(" \\\n");
}
