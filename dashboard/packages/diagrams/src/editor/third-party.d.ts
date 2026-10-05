/** Font files are emitted by the build and imported as their URL. */
declare module "*.woff2" {
  const url: string;
  export default url;
}

declare module "lodash.throttle" {
  type Throttled<T extends (...args: any[]) => any> = T & {
    cancel(): void;
    flush(): ReturnType<T> | undefined;
  };
  function throttle<T extends (...args: any[]) => any>(
    func: T,
    wait?: number,
    options?: { leading?: boolean; trailing?: boolean },
  ): Throttled<T>;
  export default throttle;
}

declare module "lodash.debounce" {
  type Debounced<T extends (...args: any[]) => any> = T & {
    cancel(): void;
    flush(): ReturnType<T> | undefined;
  };
  function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait?: number,
    options?: { leading?: boolean; trailing?: boolean; maxWait?: number },
  ): Debounced<T>;
  export default debounce;
}

declare module "pako" {
  export function deflate(data: Uint8Array | string): Uint8Array;
  export function inflate(data: Uint8Array): Uint8Array;
  export function inflate(data: Uint8Array, options: { to: "string" }): string;
}

declare module "pica" {
  const pica: any;
  export default pica;
}
