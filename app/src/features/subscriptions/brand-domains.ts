// Re-export of the SHARED brand->domain resolver (Pitch 36). The map + `brandDomain` moved to
// src/features/brands/brand-domains.ts so BOTH the Subscriptions page and the Accounts page resolve through
// ONE registry (Single Source of Truth). This shim keeps the Subscriptions page's existing import path
// working without a second copy of the map.

export { brandDomain } from "../brands/brand-domains";
