/*
 * What a bundler resolves and the compiler does not.
 *
 * These editors were built with Vite: an image import is a URL string, and a
 * `?url` suffix asks for one explicitly. TypeScript knows neither, so the shapes
 * are declared here rather than the imports being rewritten - rewriting them
 * would be editing vendored code to satisfy a compiler rather than a reader.
 */

declare module "*.png" {
    const url: string;
    export default url;
}

declare module "*.svg" {
    const url: string;
    export default url;
}

declare module "*.woff2" {
    const url: string;
    export default url;
}

declare module "*?url" {
    const url: string;
    export default url;
}

declare module "*?raw" {
    const source: string;
    export default source;
}
