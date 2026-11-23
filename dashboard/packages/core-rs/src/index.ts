/**
 * @polaris/core-rs: facades over the Rust core (docs/rust-core-plan.md).
 * Domain facades are separate entry points (`@polaris/core-rs/probe`, ...);
 * this one controls modes, loading and records for all of them.
 */

export { DOMAINS, MODES, type DomainConfig, type DomainName, type Mode } from "./registry";
export { BINDING_EXPORTS, type CoreBinding } from "./binding";
export {
    BindingMissingError,
    SLOW_CALLS_TO_TRIP,
    clearRecords,
    defineOp,
    getMode,
    ready,
    records,
    setBindingSource,
    setMode,
    setRecorder,
    status,
    type BindingSource,
    type CoreRecord,
    type CoreStatus,
    type FallbackReason,
    type OpSpec
} from "./runtime";
export { nativeFileName, nativeMlsMember, nativeSource } from "./native";
export { loadWasmBinding, useWasm } from "./wasm";
