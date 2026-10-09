/*
 * Browser check of the Google Analytics events on the booking form
 * (index.html and agents.html).
 *
 * Checks that each step sends its event, only after analytics cookies are
 * accepted, with the channel and no personal data. The booking system is
 * faked and Google's own script is blocked, so nothing is really sent.
 *
 * From the repo root (same setup as booking.test.js):
 *   jekyll build
 *   node _tests/analytics-events.test.js     or: node _tests/analytics-events.test.js path/to/site
 */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const siteDir = path.resolve(process.argv[2] || "_site");
const SLOTS = [
  { start: "2026-10-05T08:00:00Z", dayLabel: "Mon 5 Oct", timeLabel: "9:00am" },
  { start: "2026-10-06T08:00:00Z", dayLabel: "Tue 6 Oct", timeLabel: "9:00am" },
];

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || detail === undefined ? "" : "  (" + JSON.stringify(detail) + ")"));
  if (!ok) failures++;
}

function serve(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png" };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(dir, p);
      if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

// Walks the form once and returns the analytics events the page recorded.
async function run(browser, url, consent) {
  const context = await browser.newContext();
  await context.clock.setFixedTime(new Date("2026-10-01T09:00:00Z"));
  await context.addInitScript((v) => {
    try { localStorage.setItem("ecCookieConsent", JSON.stringify({ v: v, t: Date.now() })); } catch (e) {}
  }, consent);
  const page = await context.newPage();
  const replies = [{ ok: false, error: "slot_taken" }, { ok: true, reference: "EC-TEST" }];
  await page.route(/script\.google\.com/, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, slots: SLOTS }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(replies.shift()) });
  });
  await page.route(/googletagmanager|fonts\.g|trustpilot/, (route) => route.abort());
  await page.goto(url);

  await page.click('#group-rooms .item-row:nth-child(1) button[data-action="inc"]');
  await page.click("#btn-continue-book");
  await page.waitForSelector(".bf-slot-btn");
  await page.fill("#bf-postcode", "SW1A 1AA");
  await page.fill("#bf-postcode", "ba11aa");
  await page.click('.bf-day-card[data-day="Tue 6 Oct"]');
  await page.click(".bf-slot-btn >> nth=0");
  await page.fill("#bf-name", "Test Person");
  await page.fill("#bf-phone", "07000 000000");
  await page.fill("#bf-email", "test@example.com");
  await page.fill("#bf-address", "1 High Street");
  if (url.includes("agents")) await page.fill("#bf-business", "Acme Lettings");
  if (await page.isVisible("#bf-early-start")) await page.check("#bf-early-start");
  await page.click("#bf-submit");
  await page.waitForFunction(() => document.getElementById("bf-status").textContent.includes("just taken"));
  await page.waitForSelector(".bf-slot-btn");
  await page.click(".bf-slot-btn >> nth=0");
  await page.click("#bf-submit");
  await page.waitForSelector("#booking-confirmed .ref");

  const events = await page.evaluate(() =>
    (window.dataLayer || []).map((a) => Array.prototype.slice.call(a)).filter((a) => a[0] === "event").map((a) => ({ name: a[1], params: a[2] || {} })));
  await context.close();
  return events;
}

(async () => {
  if (!fs.existsSync(path.join(siteDir, "index.html"))) {
    console.error("No built site at " + siteDir + ". Run `jekyll build` first.");
    process.exit(2);
  }
  const server = await serve(siteDir);
  const base = "http://localhost:" + server.address().port + "/";
  const browser = await chromium.launch();
  try {
    for (const [file, channel] of [["index.html", "Consumer"], ["agents.html", "Agent/Landlord"]]) {
      console.log("\n== " + file);
      const denied = await run(browser, base + file, "denied");
      // booking_complete is older: it is only queued, and the page never loads Google's script without consent.
      const extra = denied.filter((e) => e.name !== "booking_complete");
      check("no step events are recorded when analytics cookies are rejected", extra.length === 0, extra.map((e) => e.name));

      const ev = await run(browser, base + file, "granted");
      const names = ev.map((e) => e.name);
      for (const n of ["booking_item_added", "booking_postcode_checked", "booking_day_picked", "booking_time_picked", "booking_details_started", "booking_confirm_pressed", "booking_failed", "booking_complete"]) {
        check("sends " + n, names.includes(n), names);
      }
      check("details started is sent once", names.filter((n) => n === "booking_details_started").length === 1, names);
      const pc = ev.filter((e) => e.name === "booking_postcode_checked").map((e) => e.params);
      check("postcode events say in or out of area, with the postcode area only",
        pc.length === 2 && pc[0].result === "out_of_area" && pc[0].postcode_area === "SW1A" && pc[1].result === "in_area" && pc[1].postcode_area === "BA1", pc);
      check("the failed booking says why", ev.find((e) => e.name === "booking_failed").params.reason === "slot_taken");
      check("every step event carries the channel", ev.every((e) => e.params.channel === channel), ev.map((e) => e.params.channel));
      const all = JSON.stringify(ev);
      check("no personal data in any event", !/Test Person|test@example|07000|BA1 1AA|SW1A 1AA|High Street|Acme/.test(all));
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
