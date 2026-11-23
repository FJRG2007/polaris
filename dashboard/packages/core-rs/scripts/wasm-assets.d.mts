export function bindingRequired(): boolean;
export function wasmAssets(options?: { required?: boolean }): {
    files: { src: string; name: string }[];
    manifest: { glue: string; wasm: string };
} | null;
