/*!
 * personalize.js — Ignitium standardized personalization listener
 * v0.5.0
 *
 * ONE reusable script, shared across every site. Host it externally and link it
 * in <head> (synchronous, no async/defer) so the deterministic paths resolve at
 * DOM-ready, before the visitor interacts. Zero required dependencies.
 *
 * Variant data is provided separately, as two globals defined BEFORE this file:
 *   window.PERSONALIZE_BASE      — shared/global defaults (optional)
 *   window.PERSONALIZE_OVERRIDES — per-site data (optional)
 * They are deep-merged, with OVERRIDES winning at the personalize-key level.
 *
 * Data shape (per account/persona slug):
 *   "acme-corp": {
 *     name: "Acme Corp",                              // optional metadata
 *     match: ["Acme Corporation, Inc.", "acme.com"],  // raw strings the enrichment event may send
 *     personalize: {
 *       "hero-logo": { type: "src",  value: "acme.svg" },
 *       "headline":  { type: "text", value: "Built for Acme's supply chain" },
 *       "cta":       { type: "href", value: "/demo?a=acme" }
 *       // a bare string is shorthand for { type: "text", value: <string> }
 *     }
 *   }
 *
 * type resolves to:
 *   "text"          -> textContent (safe default)
 *   "html"          -> innerHTML   (explicit opt-in; data is hand-maintained, use sparingly)
 *   "media-viewer"  -> sets a bundle of Ignitium Media Viewer data-* attributes on the
 *                      link/clickable element (value is a field map, see below). Never animates.
 *   any other value -> setAttribute(type, value): "src", "href", "alt", "aria-label", ...
 *
 * media-viewer value is a field map. Keys are IMV attribute names with or without the
 * "data-" prefix; the handler adds it. Only the fields you list are written; omitted
 * fields keep their authored value, "" clears a field, null removes the attribute:
 *   "video-cta": { type: "media-viewer", value: {
 *     media:     "https://.../acme.mp4",
 *     title:     "Acme — Paul Zeppenfeldt",
 *     thumbnail: "https://.../acme.webp"
 *   }}
 *
 * targets map (one wrapper key driving several sub-elements at once):
 *   "hero-cta": { targets: {
 *     "label": { type: "text",         target: ".button-text", value: "Watch Acme's story" },
 *     "media": { type: "media-viewer", value: { media: "https://.../acme.mp4", title: "Acme" } }
 *   }}
 *   Each sub-target is a normal spec, resolved within the tagged wrapper. The single-spec
 *   form ({ type, value }) is unchanged; use targets only when one key drives 2+ elements.
 *
 * Targeting (for Webflow wrappers where the tag is not on the exact element):
 *   - text swaps descend from the tagged wrapper to the text-bearing element
 *     (e.g. the <h1> inside a w-richtext div), preserving that element and its styles.
 *   - src/href swaps descend to the owning <img>/<a> if the tag sits on a wrapper.
 *   - media-viewer descends to the element carrying the IMV attributes ([data-media] /
 *     [data-clickable-wrap] / <a>), so the tag can live on the button wrapper.
 *   - spec.target narrows the search root first, then per-type descent runs inside it.
 *   - Multiple elements can share a key; all of them swap.
 *
 * Behavior:
 *   - Authored DOM content is the default. If a key has no variant value, the
 *     element is left untouched. There is no PERSONALIZE_DATA.default and no
 *     placeholder-to-default flash.
 *   - Signals resolve in priority order (preview > url > cookie > event).
 *   - The first applied signal LOCKS the page; later, lower-or-equal signals are ignored.
 *   - Deterministic signals present at load (preview/url/cookie) swap instantly.
 *   - A late enrichment event (fired after paint) animates visible text and hard-swaps
 *     offscreen ones. Attribute/media-viewer swaps always apply instantly.
 *   - If the variant data isn't defined yet at DOM-ready, a one-shot window.load retry
 *     re-resolves once everything has run.
 *
 * v0.x boundaries (intentional):
 *   - One active key at a time. Mixed persona+account on one page picks a single winner.
 *   - Lock-on-first-applied. A later "better" identification does not correct an earlier one.
 */
(function (win, doc) {
  "use strict";

  // ---- Config ----------------------------------------------------------------
  var CONFIG = {
    urlParam: "account",             // ?account=acme-corp  (deterministic)
    previewParam: "preview",         // ?preview=acme-corp  (QA override)
    cookieName: null,                // e.g. "ignitium_persona" — set to enable the cookie signal
    eventName: "ignitium:identify",  // custom event broadcast by Media Viewer / Web Script
    signalPriority: ["preview", "url", "cookie", "event"], // highest -> lowest
    animate: true,                   // animate the late (post-paint) path
    animationType: "words",          // "words" | "lines" for SplitText
    debug: false                     // or append ?pdebug=1 to any URL
  };

  var VERSION = "0.5.0";

  // ---- Small utilities -------------------------------------------------------
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i]; if (!s) continue;
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }
  function getParam(name) {
    try {
      return new URLSearchParams(win.location.search).get(name);
    } catch (e) {
      var m = win.location.search.match(new RegExp("[?&]" + name + "=([^&]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    }
  }
  function getCookie(name) {
    if (!name) return null;
    var parts = ("; " + doc.cookie).split("; " + name + "=");
    return parts.length === 2 ? decodeURIComponent(parts.pop().split(";").shift()) : null;
  }
  function log() {
    if (!CONFIG.debug) return;
    var args = ["[personalize]"].concat([].slice.call(arguments));
    try { console.log.apply(console, args); } catch (e) {}
  }
  function priorityIndex(name) {
    var i = CONFIG.signalPriority.indexOf(name);
    return i === -1 ? 999 : i;
  }

  // ---- Data merge ------------------------------------------------------------
  function buildData() {
    var base = win.PERSONALIZE_BASE || {};
    var over = win.PERSONALIZE_OVERRIDES || {};
    var out = {}, seen = {};
    Object.keys(base).forEach(function (k) { seen[k] = 1; });
    Object.keys(over).forEach(function (k) { seen[k] = 1; });
    Object.keys(seen).forEach(function (slug) {
      var b = base[slug] || {}, o = over[slug] || {};
      var merged = { match: (o.match || b.match || []).slice(),
                     personalize: assign({}, b.personalize || {}, o.personalize || {}) };
      // carry any extra metadata (e.g. name), override winning
      for (var f in b) if (f !== "match" && f !== "personalize") merged[f] = b[f];
      for (var g in o) if (g !== "match" && g !== "personalize") merged[g] = o[g];
      out[slug] = merged;
    });
    return out;
  }

  var DATA = buildData();

  // ---- Key resolution --------------------------------------------------------
  function normalize(str) {
    if (str == null) return "";
    return String(str)
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")                 // strip path from a domain
      .replace(/[^a-z0-9]+/g, " ")          // punctuation -> space
      .replace(/\b(inc|llc|ltd|plc|co|company|corp|gmbh|the)\b/g, "")
      .trim()
      .replace(/\s+/g, " ");
  }

  // Resolve any candidate (slug, company name, or domain) to a known data key.
  function resolveKey(candidate) {
    if (candidate == null || candidate === "") return null;
    if (DATA[candidate]) return candidate;                 // exact slug hit
    var n = normalize(candidate);
    if (!n) return null;
    var slugs = Object.keys(DATA);
    for (var i = 0; i < slugs.length; i++) {
      var slug = slugs[i];
      if (normalize(slug) === n) return slug;
      var m = DATA[slug].match || [];
      for (var j = 0; j < m.length; j++) if (normalize(m[j]) === n) return slug;
    }
    return null;
  }

  function keyFromEvent(detail) {
    if (!detail) return null;
    // Prefer an explicit slug, then fall back to company / domain normalization.
    return resolveKey(detail.account) ||
           resolveKey(detail.company) ||
           resolveKey(detail.domain)  || null;
  }

  // ---- Spec normalization + expansion ---------------------------------------
  function normSpec(spec) {
    if (spec == null) return null;
    if (typeof spec === "string") return { type: "text", value: spec };
    return spec;
  }

  // A key's data may be a single spec { type, value } OR a compound
  // { targets: { name: spec, ... } }. Expand to a flat list of atomic specs.
  function expandSpecs(raw) {
    var spec = normSpec(raw);
    if (!spec) return [];
    if (spec.targets && typeof spec.targets === "object") {
      var out = [];
      for (var k in spec.targets) {
        if (!Object.prototype.hasOwnProperty.call(spec.targets, k)) continue;
        var s = normSpec(spec.targets[k]);
        if (s) out.push(s);
      }
      return out;
    }
    return [spec];
  }

  // ---- Target resolution -----------------------------------------------------
  // A data-personalize tag often sits on a Webflow wrapper while the real element
  // lives nested inside. spec.target narrows the search root; per-type descent then
  // finds the exact node within it.

  var TEXT_TAGS = /^(H1|H2|H3|H4|H5|H6|P|SPAN|A|STRONG|EM|B|I|LI|BLOCKQUOTE|LABEL|BUTTON|FIGCAPTION|TD|TH|SMALL|CODE)$/;
  var DESCENDABLE = /^(H1|H2|H3|H4|H5|H6|P|SPAN|A|STRONG|EM|B|I|LI|BLOCKQUOTE|LABEL|BUTTON|FIGCAPTION|TD|TH|SMALL|CODE|DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN)$/;

  function hasOwnText(el) {
    var n = el.childNodes || [];
    for (var i = 0; i < n.length; i++) {
      if (n[i].nodeType === 3 && n[i].nodeValue && n[i].nodeValue.trim() !== "") return true;
    }
    return false;
  }

  function textTarget(el) {
    var cur = el, depth = 0, MAX = 6;
    while (depth < MAX) {
      var kids = cur.children;
      if (!kids || kids.length === 0) return cur;            // leaf: write here
      if (hasOwnText(cur)) return cur;                       // mixed inline content: replace whole element
      if (kids.length === 1) {
        if (DESCENDABLE.test(kids[0].tagName)) { cur = kids[0]; depth++; continue; }
        return cur;                                          // single non-text child (img/svg): stop
      }
      var textKids = [];
      for (var i = 0; i < kids.length; i++) if (TEXT_TAGS.test(kids[i].tagName)) textKids.push(kids[i]);
      if (textKids.length === 1) { cur = textKids[0]; depth++; continue; } // one obvious text child
      return cur;                                            // ambiguous: write at current level
    }
    return cur;
  }

  function attrTarget(el, type) {
    if (type === "src" || type === "srcset" || type === "alt") {
      if (/^(IMG|SOURCE|VIDEO|AUDIO|IFRAME|SCRIPT)$/.test(el.tagName)) return el;
      return el.querySelector("img,source,video,iframe") || el;
    }
    if (type === "href") {
      if (/^(A|AREA|LINK)$/.test(el.tagName)) return el;
      return el.querySelector("a") || el;
    }
    return el; // generic attribute (aria-label, etc.) stays on the element
  }

  // Find the element carrying the Ignitium Media Viewer attributes. The tag may sit
  // directly on the clickable element or on its wrapper; either way, land on the node
  // that owns data-media / data-clickable-wrap (or an <a> as a last resort).
  function mvTarget(base) {
    if (base.hasAttribute && (base.hasAttribute("data-media") || base.hasAttribute("data-clickable-wrap"))) return base;
    if (/^(A|AREA)$/.test(base.tagName)) return base;
    return (base.querySelector && base.querySelector("[data-media],[data-clickable-wrap],a")) || base;
  }

  function getTarget(el, spec) {
    var base = spec.target ? (el.querySelector(spec.target) || el) : el;
    if (spec.type === "media-viewer") return mvTarget(base);
    if (spec.type === "text")         return textTarget(base);
    if (spec.type === "html")         return base;
    return attrTarget(base, spec.type);
  }

  // ---- Applying values -------------------------------------------------------
  // media-viewer: write a bundle of data-* attributes. Only listed fields change;
  // "" clears a field, null removes it, omitted fields keep their authored value.
  function applyMediaViewer(t, fields) {
    if (!t || !fields || typeof fields !== "object") return;
    for (var k in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
      var name = k.indexOf("data-") === 0 ? k : "data-" + k;
      var v = fields[k];
      if (v === null || v === undefined) { if (t.removeAttribute) t.removeAttribute(name); }
      else if (t.setAttribute) t.setAttribute(name, String(v));
    }
  }

  function applyValue(el, spec) {
    var t = getTarget(el, spec);
    if (spec.type === "text")              t.textContent = spec.value;
    else if (spec.type === "html")         t.innerHTML   = spec.value;
    else if (spec.type === "media-viewer") applyMediaViewer(t, spec.value);
    else                                   t.setAttribute(spec.type, spec.value);
  }

  // ---- Motion (late path only) ----------------------------------------------
  function prefersReduced() {
    try { return win.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }
  function hasGsap()   { return typeof win.gsap !== "undefined"; }
  function getSplit()  { return win.SplitText || (win.gsap && win.gsap.SplitText) || null; }

  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;         // display:none / zero-size
    var vh = win.innerHeight || doc.documentElement.clientHeight;
    var vw = win.innerWidth  || doc.documentElement.clientWidth;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  function splitTextSwap(t, value, ST) {
    var g = win.gsap;
    g.to(t, { opacity: 0, duration: 0.12, ease: "power1.in", onComplete: function () {
      t.textContent = value;
      t.setAttribute("aria-label", value); // keep the full string accessible during the split
      g.set(t, { opacity: 1 });
      var split = null;
      try { split = new ST(t, { type: CONFIG.animationType, aria: "hidden" }); }
      catch (e) { try { split = ST.create(t, { type: CONFIG.animationType }); } catch (e2) {} }
      if (!split) { t.removeAttribute("aria-label"); return; }
      var parts = split[CONFIG.animationType] || split.words || split.lines || [];
      g.from(parts, {
        opacity: 0, yPercent: 40, duration: 0.5, ease: "power2.out", stagger: 0.03,
        onComplete: function () { try { split.revert(); } catch (e) {} t.removeAttribute("aria-label"); }
      });
    }});
  }
  function fadeText(t, value) {
    var g = win.gsap;
    g.to(t, { opacity: 0, duration: 0.15, onComplete: function () {
      t.textContent = value; g.to(t, { opacity: 1, duration: 0.25 });
    }});
  }
  function cssFadeText(t, value) {
    var prev = t.style.transition;
    t.style.transition = "opacity 0.15s ease";
    t.style.opacity = "0";
    win.setTimeout(function () {
      t.textContent = value;
      t.style.opacity = "1";
      win.setTimeout(function () { t.style.transition = prev; }, 220);
    }, 160);
  }

  function animateSwap(el, spec) {
    if (spec.type === "media-viewer") { applyValue(el, spec); return; } // config swap: never animate
    if (prefersReduced())             { applyValue(el, spec); return; }
    var t = getTarget(el, spec);
    if (spec.type === "text") {
      var ST = getSplit();
      if (ST && hasGsap()) return splitTextSwap(t, spec.value, ST);
      if (hasGsap())       return fadeText(t, spec.value);
      return cssFadeText(t, spec.value);
    }
    // attribute / html swap: crossfade the target if GSAP is present, else instant
    if (hasGsap()) {
      win.gsap.to(t, { opacity: 0, duration: 0.15, onComplete: function () {
        applyValue(el, spec); win.gsap.to(t, { opacity: 1, duration: 0.2 });
      }});
    } else {
      applyValue(el, spec);
    }
  }

  // Apply one atomic spec to the tagged element, animating only when it makes sense.
  function swapOne(el, spec, animate, reduced) {
    if (!spec || !spec.type) return;
    if (spec.type === "media-viewer") { applyValue(el, spec); return; } // always instant
    if (animate && !reduced && isVisible(getTarget(el, spec))) animateSwap(el, spec);
    else applyValue(el, spec);
  }

  // ---- Orchestration ---------------------------------------------------------
  var state = { appliedKey: null, appliedSignal: null, appliedIndex: null, locked: false };
  var initialResolveDone = false;
  var queuedEvent = null;

  function apply(slug, signalName, animate) {
    var variant = DATA[slug];
    if (!variant || !variant.personalize) { log("no variant for", slug); return false; }

    state.appliedKey = slug;
    state.appliedSignal = signalName;
    state.appliedIndex = priorityIndex(signalName);
    state.locked = true;

    var reduced = prefersReduced();
    var nodes = doc.querySelectorAll("[data-personalize]");
    var swapped = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute("data-personalize");
      var atoms = expandSpecs(variant.personalize[key]);
      for (var a = 0; a < atoms.length; a++) { swapOne(el, atoms[a], animate, reduced); swapped++; }
    }
    log("applied", slug, "via", signalName, "(" + swapped + " elements, animate=" + !!animate + ")");
    return true;
  }

  // Gather signals, apply the highest-priority match. Returns true if a swap was applied.
  function doResolve() {
    DATA = buildData(); // rebuild from current globals (order-independent)
    var candidates = [];
    var pv = resolveKey(getParam(CONFIG.previewParam)); if (pv) candidates.push(["preview", pv]);
    var ur = resolveKey(getParam(CONFIG.urlParam));     if (ur) candidates.push(["url", ur]);
    var ck = resolveKey(getCookie(CONFIG.cookieName));  if (ck) candidates.push(["cookie", ck]);
    if (queuedEvent) { var ek = keyFromEvent(queuedEvent); if (ek) candidates.push(["event", ek]); }
    candidates.sort(function (a, b) { return priorityIndex(a[0]) - priorityIndex(b[0]); });
    if (candidates.length) {
      apply(candidates[0][1], candidates[0][0], /* animate */ false); // resolved at load -> instant
      return true;
    }
    return false;
  }

  function initialResolve() {
    var applied = doResolve();
    initialResolveDone = true;
    queuedEvent = null;
    if (applied) return;

    log("no signal at load; authored content stands");

    // If variant data hasn't arrived yet (e.g. externalized/late-injected data blocks
    // that define the globals after DOMContentLoaded), try once more after full load.
    if (Object.keys(DATA).length === 0) {
      win.addEventListener("load", function onLoad() {
        win.removeEventListener("load", onLoad);
        if (state.locked) return;
        if (doResolve()) log("resolved after load (data arrived late)");
        else log("still no data after load; check that PERSONALIZE_BASE/OVERRIDES are defined");
      });
    }
  }

  function onIdentify(e) {
    var detail = (e && e.detail) || {};
    if (!initialResolveDone) { queuedEvent = detail; log("event queued (pre-DOM)"); return; }

    // Event is the lowest-priority signal; if anything already applied, ignore it.
    if (state.locked && state.appliedIndex <= priorityIndex("event")) {
      log("event ignored; already locked by", state.appliedSignal);
      return;
    }
    var slug = keyFromEvent(detail);
    if (!slug) { log("event: no key match for", detail); return; }
    apply(slug, "event", CONFIG.animate); // late path -> visible text animates
  }

  // ---- Boot ------------------------------------------------------------------
  if (getParam("pdebug") === "1") CONFIG.debug = true;
  doc.addEventListener(CONFIG.eventName, onIdentify); // register early so pre-DOM events queue

  function ready(fn) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  ready(initialResolve);

  // ---- Public API (testing + dynamic DOM) -----------------------------------
  win.Personalize = {
    version: VERSION,
    config: CONFIG,
    data: function () { return DATA; },
    refresh: function () { DATA = buildData(); state.locked = false; state.appliedKey = null;
                           state.appliedSignal = null; state.appliedIndex = null;
                           initialResolveDone = false; initialResolve(); },
    applyKey: function (slug, opts) { opts = opts || {}; return apply(slug, opts.signal || "manual", !!opts.animate); },
    simulateEvent: function (detail) { doc.dispatchEvent(new CustomEvent(CONFIG.eventName, { detail: detail || {} })); },
    resolveKey: resolveKey,
    getState: function () { return assign({}, state); }
  };
})(window, document);
