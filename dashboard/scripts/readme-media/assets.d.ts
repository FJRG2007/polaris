// bundle.mjs loads a picture as a data URL, so an imported one is that string.
declare module "*.png" {
    const url: string;
    export default url;
}
