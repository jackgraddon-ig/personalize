/*
 * personalize-base.js - SHARED default variant data
 *
 * Hosted externally (Cloudflare), linked as a synchronous <script src> in <head>,
 * BEFORE personalize.js. Carries data that is genuinely global and reused across
 * sites: slug, match strings, and the brand-compliant logo URL. Per-site copy
 * lives in window.PERSONALIZE_OVERRIDES and wins at the personalize-key level.
 *
 * Swap the logo URLs for wherever the approved files actually live
 * (Webflow assets, Cloudflare, a DAM, etc.).
 */
window.PERSONALIZE_BASE = {
  "acme-corp": {
    name: "Acme Corp",
    match: ["Acme Corporation, Inc.", "Acme Corp", "acme.com"],
    personalize: {
      "hero-logo": { type: "src", value: "https://assets.ignitium.com/logos/acme.svg" }
    }
  },
  "beta-inc": {
    name: "Beta Inc",
    match: ["Beta Industries, LLC", "Beta Inc", "beta.io"],
    personalize: {
      "hero-logo": { type: "src", value: "https://assets.ignitium.com/logos/beta.svg" }
    }
  }
};
