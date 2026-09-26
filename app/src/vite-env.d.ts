/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Demo build flag. "1" (set as `VITE_DEMO=1 npm run build`) produces a static, backend-less bundle:
  // collections read from in-memory seeded data and the API helpers return baked/no-op responses. Unset
  // for dev and real prod, where it is statically false so all demo code is tree-shaken out.
  readonly VITE_DEMO?: string;
}
