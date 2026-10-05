/** Build-time values, replaced by the package build (see scripts/build.mjs). */
interface ImportMetaEnv {
  MODE: string;
  DEV: boolean;
  PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
