/*!
 * personalize.js — Ignitium standardized personalization listener
 * v0.3.0
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
 *   "text"  -> textContent (safe default)
 *   "html"  -> innerHTML   (explicit opt-in; data is hand-maintained, use sparingly)
 *   any other value        -> setAttribute(type, value): "src", "href", "alt", "aria-label", ...
 *
 * Targeting (for Webflow wrappers where the tag is not on the exact element):
 *   - text swaps descend from the tagged wrapper to the text-bearing element
 *     (e.g. the <h1> inside a w-richtext div), preserving that element and its styles.
 *   - src/href swaps descend to the owning <img>/<a> if the tag sits on a wrapper.
 *   - For anything the auto-descent gets wrong, add an explicit selector:
 *       "cta": { type: "href", value: "/demo", target: "a.clickable-link" }
 *     spec.target is querySelector'd within the tagged element and always wins.
 *   - Multiple elements can share a key; all of them swap. Give a button's visible
 *     label and its sr-only spans the same key to keep them in sync.
 *
 * Behavior:
 *   - Authored DOM content is the default. If a key has no variant value, the
 *     element is left untouched. There is no PERSONALIZE_DATA.default and no
 *     placeholder-to-default flash.
 *   - Signals resolve in priority order (preview > url > cookie > event).
 *   - The first applied signal LOCKS the page; later, lower-or-equal signals are ignored.
 *   - Deterministic signals present at load (preview/url/cookie) swap instantly.
 *   - A late enrichment event (fired after paint) animates visible elements and
 *     hard-swaps offscreen ones. Enhances with GSAP + SplitText when present.
 *
 * v0.1 boundaries (intentional):
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

  var VERSION = "0.1.0";

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

  // ---- Applying values -------------------------------------------------------
  function normSpec(spec) {
    if (spec == null) return null;
    if (typeof spec === "string") return { type: "text", value: spec };
    return spec;
  }

  // A data-personalize tag often sits on a Webflow wrapper (w-richtext, component
  // root) while the real text/link lives nested inside. Resolve the true target.
  //
  // Precedence: an explicit spec.target selector always wins. Otherwise:
  //   text -> descend to the text-bearing element (e.g. the <h1> in a w-richtext)
  //   html -> the tagged element itself (innerHTML replaces its contents)
  //   attr -> descend to the element that owns the attribute (<img> for src, <a> for href)

  var TEXT_TAGS = /^(H1|H2|H3|H4|H5|H6|P|SPAN|A|STRONG|EM|B|I|LI|BLOCKQUOTE|LABEL|BUTTON|FIGCAPTION|TD|TH|SMALL|CODE)$/;
  var DESCENDABLE = /^(H1|H2|H3|H4|H5|H6|P|SPAN|A|STRONG|EM|B|I|LI|BLOCKQUOTE|LABEL|BUTTON|FIGCAPTION|TD|TH|SMALL|CODE|DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN)$/;

  // True if the element has its own non-whitespace text (mixed inline content),
  // which means it IS the text element and should be replaced wholesale.
  function hasOwnText(el) {
    var n = el.childNodes || [];
    for (var i = 0; i < n.length; i++) {
      if (n[i].nodeType === 3 && n[i].nodeValue && n[i].nodeValue.trim() !== "") return true;
    }
    return false;
  }

  // Walk down single-child / single-text-child chains to the element that should
  // hold the text. Iterative + depth-capped, so it can never loop.
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
    return el; // generic attribute (aria-label, etc.) stays on the tagged element
  }

  function getTarget(el, spec) {
    if (spec.target) return el.querySelector(spec.target) || el; // explicit override
    if (spec.type === "text") return textTarget(el);
    if (spec.type === "html") return el;
    return attrTarget(el, spec.type);
  }

  function applyValue(el, spec) {
    var t = getTarget(el, spec);
    if (spec.type === "text")      t.textContent = spec.value;
    else if (spec.type === "html") t.innerHTML  = spec.value;
    else                           t.setAttribute(spec.type, spec.value);
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

  // All motion helpers operate on the already-resolved target element `t`.
  function splitText(t, value, ST) {
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
    if (prefersReduced()) { applyValue(el, spec); return; }
    var t = getTarget(el, spec);
    if (spec.type === "text") {
      var ST = getSplit();
      if (ST && hasGsap()) return splitText(t, spec.value, ST);
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
      var spec = normSpec(variant.personalize[key]);
      if (!spec) continue;                       // leave authored content in place
      if (animate && !reduced && isVisible(getTarget(el, spec))) animateSwap(el, spec);
      else applyValue(el, spec);
      swapped++;
    }
    log("applied", slug, "via", signalName, "(" + swapped + " elements, animate=" + !!animate + ")");
    return true;
  }

  function initialResolve() {
    var candidates = [];
    var pv = resolveKey(getParam(CONFIG.previewParam)); if (pv) candidates.push(["preview", pv]);
    var ur = resolveKey(getParam(CONFIG.urlParam));     if (ur) candidates.push(["url", ur]);
    var ck = resolveKey(getCookie(CONFIG.cookieName));  if (ck) candidates.push(["cookie", ck]);
    if (queuedEvent) { var ek = keyFromEvent(queuedEvent); if (ek) candidates.push(["event", ek]); }

    candidates.sort(function (a, b) { return priorityIndex(a[0]) - priorityIndex(b[0]); });
    initialResolveDone = true;

    if (candidates.length) {
      apply(candidates[0][1], candidates[0][0], /* animate */ false); // resolved at load -> instant
    } else {
      log("no signal at load; authored content stands");
    }
    queuedEvent = null;
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
    apply(slug, "event", CONFIG.animate); // late path -> visible elements animate
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
