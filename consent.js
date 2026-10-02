/*
 * EasyClean Somerset: cookie consent.
 *
 * Nothing that sets cookies loads until the visitor says yes:
 *   - Google Analytics (gtag.js) is only injected after "Accept".
 *   - Trustpilot's review widget script is only injected after "Accept"
 *     (until then, its placeholder shows a plain "Leave us a review" link).
 * Before a choice, the page's own gtag() calls (e.g. booking_complete) just
 * queue in dataLayer and are never sent unless the visitor accepts.
 *
 * The choice is kept in this browser's localStorage (not a cookie) and asked
 * again after 12 months. "Cookie settings" in the footer reopens the banner.
 * Included on index.html, agents.html, faq.html, terms.html, privacy.html.
 */
(function () {
  var GA_ID = "G-14GB1T63G8";
  var TRUSTPILOT_SRC = "https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js";
  var KEY = "ecCookieConsent";
  var MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== "function") {
    window.gtag = function () { window.dataLayer.push(arguments); };
  }

  function readChoice() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || (c.v !== "granted" && c.v !== "denied")) return null;
      if (Date.now() - (c.t || 0) > MAX_AGE_MS) return null;
      return c.v;
    } catch (e) { return null; }
  }

  function saveChoice(v) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: v, t: Date.now() })); } catch (e) {}
  }

  var loaded = false;
  function loadOptional() {
    if (loaded) return;
    loaded = true;
    window.gtag("js", new Date());
    window.gtag("config", GA_ID);
    addScript("https://www.googletagmanager.com/gtag/js?id=" + GA_ID);
    if (document.querySelector(".trustpilot-widget")) addScript(TRUSTPILOT_SRC);
  }

  function addScript(src) {
    var s = document.createElement("script");
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  // Removes Google Analytics cookies after someone withdraws consent.
  function clearAnalyticsCookies() {
    var host = location.hostname;
    var domains = ["", host, "." + host, "." + host.replace(/^www\./, "")];
    document.cookie.split(";").forEach(function (c) {
      var name = c.split("=")[0].trim();
      if (/^_ga(_|$)|^_gid$|^_gat/.test(name)) {
        domains.forEach(function (d) {
          document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + (d ? "; domain=" + d : "");
        });
      }
    });
  }

  function decide(v) {
    var before = readChoice();
    saveChoice(v);
    hideBanner();
    if (v === "granted") {
      loadOptional();
    } else {
      clearAnalyticsCookies();
      // If analytics was already running on this page, reload so it stops.
      if (before === "granted" && loaded) location.reload();
    }
  }

  var banner = null;
  function showBanner() {
    if (banner) { banner.style.display = "block"; focusFirst(); return; }
    injectStyles();
    banner = document.createElement("div");
    banner.className = "ec-consent";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Cookie choices");
    banner.innerHTML =
      '<div class="ec-consent-inner">' +
        '<p class="ec-consent-text">We&#8217;d like to use cookies to see how the site is used and to show our Trustpilot reviews. They&#8217;re only set if you accept. ' +
          '<a href="privacy.html#cookies">Cookie info</a></p>' +
        '<div class="ec-consent-actions">' +
          '<button type="button" class="ec-consent-btn" data-choice="denied">Reject</button>' +
          '<button type="button" class="ec-consent-btn" data-choice="granted">Accept</button>' +
        '</div>' +
      '</div>';
    banner.addEventListener("click", function (e) {
      var choice = e.target && e.target.getAttribute && e.target.getAttribute("data-choice");
      if (choice) decide(choice);
    });
    document.body.appendChild(banner);
    focusFirst();
  }

  function focusFirst() {
    // Move keyboard focus to the banner only when someone reopens it from
    // "Cookie settings", not on page load (that would jump the page).
    if (banner && banner._reopened) {
      var b = banner.querySelector("button");
      if (b) b.focus();
    }
  }

  function hideBanner() {
    if (banner) banner.style.display = "none";
  }

  function injectStyles() {
    var css =
      ".ec-consent{position:fixed;left:12px;right:12px;bottom:12px;z-index:1000;max-width:720px;margin:0 auto;" +
        "background:var(--surface,#fff);color:var(--ink,#12232B);border:1px solid var(--line,#DCE3E2);border-radius:8px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.18);font-family:'Public Sans',Arial,sans-serif;}" +
      ".ec-consent-inner{display:flex;gap:14px;align-items:center;padding:14px 16px;flex-wrap:wrap;}" +
      ".ec-consent-text{margin:0;flex:1 1 320px;font-size:14px;line-height:1.5;}" +
      ".ec-consent-text a{color:var(--teal-deep,#0A5960);font-weight:600;}" +
      ".ec-consent-actions{display:flex;gap:10px;flex:0 0 auto;}" +
      ".ec-consent-btn{font-family:inherit;font-weight:700;font-size:15px;padding:11px 20px;border-radius:4px;cursor:pointer;" +
        "background:var(--surface,#fff);color:var(--ink,#12232B);border:1.5px solid var(--ink,#12232B);min-width:96px;}" +
      ".ec-consent-btn:hover{background:var(--ink,#12232B);color:var(--surface,#fff);}" +
      "@media (max-width:480px){.ec-consent-actions{width:100%}.ec-consent-btn{flex:1}}";
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  }

  function wireSettingsLinks() {
    var links = document.querySelectorAll("[data-cookie-settings]");
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener("click", function (e) {
        e.preventDefault();
        showBanner();
        if (banner) { banner._reopened = true; focusFirst(); }
      });
    }
  }

  function start() {
    var choice = readChoice();
    if (choice === "granted") loadOptional();
    else if (!choice) showBanner();
    wireSettingsLinks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

