/*
 * Browser check of unsubscribe.html (the link at the bottom of marketing emails, FRE-219).
 *
 * The booking system (Apps Script) is faked. The page is plain HTML, so this
 * serves the repo folder directly and needs no Jekyll build.
 *
 * From the repo root:
 *   cd _tests && npm install && npx playwright install chromium && cd ..
 *   node _tests/unsubscribe-page.test.js
 *
 * Prints PASS/FAIL per check and exits non-zero if anything failed.
 */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const siteDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || detail === undefined ? "" : "  (" + JSON.stringify(detail) + ")"));
  if (!ok) failures++;
}

function serve(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png" };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split("?")[0]);
      const file = path.join(dir, p);
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

const TOKEN = "0123456789abcdef0123456789abcdef";
const BAD_TEXT = "This link doesn’t look right. Reply STOP to any of our emails, or WhatsApp us, and we’ll take you off the list.";
const WRONG_TEXT = "Something went wrong. Please try again, or reply STOP to any of our emails.";

// `replies` are the POST replies in order; an entry of "fail" is a network failure.
async function open(browser, base, query, replies, delayMs) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const fake = { posts: [], other: [], errors: [] };
  page.on("pageerror", (e) => fake.errors.push(e.message));
  await page.route(/script\.google\.com/, async (route) => {
    const req = route.request();
    if (req.method() !== "POST") { fake.other.push(req.method() + " " + req.url()); return route.fulfill({ body: "{}" }); }
    fake.posts.push({ body: JSON.parse(req.postData()), type: req.headers()["content-type"] });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const reply = replies.shift();
    if (reply === "fail") return route.abort();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
  });
  const outside = [];
  await page.route(/^https?:\/\/(?!localhost)(?!script\.google\.com)/, (route) => { outside.push(route.request().url()); return route.abort(); });
  fake.outside = outside;
  await page.goto(base + "unsubscribe.html" + query);
  return { page, fake, context };
}

const active = (page) => page.$eval(".state.active", (el) => el.id);
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());

(async () => {
  const server = await serve(siteDir);
  const base = "http://localhost:" + server.address().port + "/";
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  const html = fs.readFileSync(path.join(siteDir, "unsubscribe.html"), "utf8");
  check("page is noindex, nofollow", /<meta name="robots" content="noindex, nofollow">/.test(html));
  check("page sends no referrer", /<meta name="referrer" content="no-referrer">/.test(html));
  check("page is not in the sitemap", !/unsubscribe/.test(fs.readFileSync(path.join(siteDir, "sitemap.xml"), "utf8")));
  check("page has no analytics", !/googletagmanager|gtag\(|google-analytics|G-[A-Z0-9]{6,}|consent\.js/.test(html));
  check("page has no em dashes", !html.includes("—") && !html.includes("&mdash;"));
  check("page has no email address", !/[\w.+-]+@[\w-]+\.[\w.]+/.test(html));

  // Good token: asks, and sends nothing on load
  {
    const { page, fake, context } = await open(browser, base, "?u=" + TOKEN, [{ ok: true, already: false }]);
    await page.waitForTimeout(400);
    check("no POST on page load", fake.posts.length === 0 && fake.other.length === 0, [fake.posts, fake.other]);
    check("shows the ask screen", (await active(page)) === "state-ask");
    check("heading is Stop marketing emails", (await text(page, "#h-ask")) === "Stop marketing emails");
    check("one line of explanation", (await text(page, "#state-ask .msg")) === "You’ll stop getting offers and reminders from EasyClean Somerset. Emails about a booking you make still come as normal.");
    check("one button, Stop marketing emails", (await page.$$eval("#state-ask button", (b) => b.map((x) => x.textContent.trim()))).join() === "Stop marketing emails");
    check("nothing goes to other sites", fake.outside.length === 0, fake.outside);

    await page.click("#btn-stop");
    await page.waitForSelector("#state-done.state.active");
    check("POST sent once on press", fake.posts.length === 1, fake.posts);
    check("POST is { action: unsubscribe, u }", JSON.stringify(fake.posts[0].body) === JSON.stringify({ action: "unsubscribe", u: TOKEN }), fake.posts[0].body);
    check("POST is text/plain (no CORS preflight)", /^text\/plain/.test(fake.posts[0].type), fake.posts[0].type);
    check("ok, not already: Done message", (await text(page, "#done-text")) === "Done. You won’t get any more marketing emails from us.");
    check("no script errors", fake.errors.length === 0, fake.errors);
    await context.close();
  }

  // Already unsubscribed
  {
    const { page, context } = await open(browser, base, "?u=" + TOKEN, [{ ok: true, already: true }]);
    await page.click("#btn-stop");
    await page.waitForSelector("#state-done.state.active");
    check("ok, already: already-unsubscribed message", (await text(page, "#done-text")) === "You’re already unsubscribed. You won’t get any more marketing emails from us.");
    await context.close();
  }

  // not_found from the booking system
  {
    const { page, context } = await open(browser, base, "?u=" + TOKEN, [{ ok: false, error: "not_found" }]);
    await page.click("#btn-stop");
    await page.waitForSelector("#state-bad.state.active");
    check("not_found: link doesn't look right, with WhatsApp", (await text(page, "#bad-text")) === BAD_TEXT && (await page.$$eval("#state-bad a[href^='https://wa.me/']", (a) => a.length)) === 1);
    await context.close();
  }

  // busy, server_error, network failure: message, button back, can press again
  for (const first of [{ ok: false, error: "busy" }, { ok: false, error: "server_error" }, "fail"]) {
    const label = first === "fail" ? "network failure" : first.error;
    const { page, fake, context } = await open(browser, base, "?u=" + TOKEN, [first, { ok: true, already: false }]);
    await page.click("#btn-stop");
    await page.waitForSelector("#stop-status:not([hidden])");
    check(label + ": try again message", (await text(page, "#stop-status")) === WRONG_TEXT);
    check(label + ": stays on the ask screen, button enabled again", (await active(page)) === "state-ask" && !(await page.$eval("#btn-stop", (b) => b.disabled)));
    await page.click("#btn-stop");
    await page.waitForSelector("#state-done.state.active");
    check(label + ": second press works", fake.posts.length === 2 && (await text(page, "#done-text")).startsWith("Done."), fake.posts.length);
    await context.close();
  }

  // Button is off while sending, and a double click sends once
  {
    const { page, fake, context } = await open(browser, base, "?u=" + TOKEN, [{ ok: true, already: false }], 600);
    await page.click("#btn-stop");
    check("button is disabled while sending", await page.$eval("#btn-stop", (b) => b.disabled));
    await page.dispatchEvent("#btn-stop", "click");
    await page.waitForSelector("#state-done.state.active");
    check("only one POST for a double press", fake.posts.length === 1, fake.posts.length);
    await context.close();
  }

  // Bad or missing tokens: message, WhatsApp link, no button, no POST
  const bads = { "missing": "", "empty": "?u=", "too short": "?u=0123abcd", "31 characters": "?u=" + TOKEN.slice(1), "33 characters": "?u=" + TOKEN + "a", "not hex": "?u=" + "g".repeat(32) };
  for (const label of Object.keys(bads)) {
    const { page, fake, context } = await open(browser, base, bads[label], []);
    await page.waitForTimeout(300);
    check("token " + label + ": link doesn't look right message", (await active(page)) === "state-bad" && (await text(page, "#bad-text")) === BAD_TEXT);
    check("token " + label + ": WhatsApp link, no button, no POST", (await page.$$eval("#state-bad a[href^='https://wa.me/']", (a) => a.length)) === 1 && !(await page.isVisible("#btn-stop")) && fake.posts.length === 0);
    await context.close();
  }

  // Layout
  {
    const { page, context } = await open(browser, base, "?u=" + TOKEN, []);
    check("no horizontal scroll at 390px", await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    await context.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? "\n" + failures + " check(s) FAILED" : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})();
