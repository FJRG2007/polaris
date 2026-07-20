// archiver-zip-encrypted ships no types. It is registered with archiver via
// archiver.registerFormat("zip-encrypted", <this module>); the module value is
// only ever passed there, so an opaque type is sufficient.
declare module "archiver-zip-encrypted" {
    const format: unknown;
    export default format;
}
