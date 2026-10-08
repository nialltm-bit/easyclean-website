/*
 * Browser check of my-booking.html (change or cancel a booking).
 *
 * The booking system (Apps Script) is faked, so nothing reaches the real
 * calendar. my-booking.html is plain HTML, so this serves the repo folder
 * directly and needs no Jekyll build.
 *
 * From the repo root:
 *   cd _tests && npm install && npx playwright install chromium && cd ..
 *   node _tests/my-booking.test.js            or: node _tests/my-booking.test.js path/to/site
 *   SHOTS=dir node _tests/my-booking.test.js  also saves 390px screenshots, light and dark
 *
 * Prints PASS/FAIL per check and exits non-zero if anything failed.
 */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const siteDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const shotsDir = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

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

// The page's clock is fixed at Thu 8 Oct 2026. Times are British Summer Time
// until 25 Oct, so 9:00am is 08:00Z.
const NOW = "2026-10-08T09:00:00Z";
const BOOKING = {
  ok: true, reference: "EC-1234", channel: "homeowner", date: "2026-10-12", time: "09:00",
  whenLabel: "Mon 12 Oct at 9:00am", addressShort: "12 Ivy Walk, BA3", items: [{ name: "Small room", qty: 2 }, { name: "Armchair", qty: 1 }],
  total: 95, estMins: 115, canChange: true, notChangeableReason: null, movesLeft: 2,
  cancelDeadline: "2026-10-20", earlyStartGiven: false,
};
const SLOTS = [
  { start: "2026-10-13T08:00:00Z", dayLabel: "Tue 13 Oct", timeLabel: "9:00am" },
  { start: "2026-10-13T13:00:00Z", dayLabel: "Tue 13 Oct", timeLabel: "2:00pm" },
  { start: "2026-10-21T08:00:00Z", dayLabel: "Wed 21 Oct", timeLabel: "9:00am" },
];

// Opens the page with the booking system faked. `fake.booking` and
// `fake.slots` are replies for the GETs; `fake.posts` collects POSTs and
// `fake.postReplies` supplies their replies in order.
async function open(browser, base, opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: opts.dark ? "dark" : "light" });
  await context.clock.setFixedTime(new Date(NOW));
  const page = await context.newPage();
  const fake = { booking: opts.booking || BOOKING, slots: opts.slots || { ok: true, slots: SLOTS }, posts: [], postReplies: [], gets: [], errors: [] };
  page.on("pageerror", (e) => fake.errors.push(e.message));
  await page.route(/script\.google\.com/, (route) => {
    const req = route.request();
    const json = (o) => route.fulfill({ contentType: "application/json", body: JSON.stringify(o) });
    if (req.method() === "GET") {
      fake.gets.push(req.url());
      if (fake.bookingFails) return route.fulfill({ status: 500, body: "down" });
      return json(/action=rescheduleSlots/.test(req.url()) ? fake.slots : fake.booking);
    }
    fake.posts.push(JSON.parse(req.postData()));
    return json(fake.postReplies.shift());
  });
  await page.route(/fonts\.g/, (route) => route.abort());
  await page.goto(base + "my-booking.html" + (opts.noToken ? "" : "?t=" + (opts.token || "MANAGE123")));
  return { page, fake, context };
}

const active = (page) => page.$eval(".state.active", (el) => el.id);
const waitState = (page, id) => page.waitForSelector("#" + id + ".state.active");
const focusedId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);
async function shot(page, name, dark) {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, name + "-" + (dark ? "dark" : "light") + ".png"), fullPage: true });
}

async function run(browser, base, dark) {
  console.log("\n== " + (dark ? "dark" : "light") + " mode");
  const tag = dark ? "dark: " : "";

  // Main view
  {
    const { page, fake, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    check(tag + "asks for the booking by its Manage token", fake.gets[0].includes("action=booking") && fake.gets[0].includes("t=MANAGE123"), fake.gets);
    const text = await page.textContent("#summary");
    check(tag + "summary shows day and time, short address, items and total", ["Mon 12 Oct at 9:00am", "12 Ivy Walk, BA3", "2 × Small room, 1 × Armchair", "£95"].every((s) => text.includes(s)), text);
    check(tag + "two buttons: Change date or time and Cancel booking", (await page.textContent("#btn-change")) === "Change date or time" && (await page.textContent("#btn-cancel")) === "Cancel booking");
    check(tag + "only the main view is showing", (await page.$$eval(".state", (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.id))).join() === "state-main");
    check(tag + "focus moves to the heading", (await focusedId(page)) === "h-main", await focusedId(page));
    await shot(page, "1-main", dark);

    // Change
    await page.click("#btn-change");
    await waitState(page, "state-change");
    await page.waitForSelector(".bf-day-card");
    check(tag + "asks for reschedule times for the same token", fake.gets[1].includes("action=rescheduleSlots") && fake.gets[1].includes("t=MANAGE123"), fake.gets);
    check(tag + "the time picker is a fieldset with a legend", await page.$eval("#state-change fieldset legend", (l) => l.textContent === "Choose a time"));
    const days = await page.$$eval(".bf-day-card", (els) => els.map((e) => e.getAttribute("data-day")));
    check(tag + "days run on without gaps, first day has times selected", days.slice(0, 3).join() === "Tue 13 Oct,Wed 14 Oct,Thu 15 Oct" && (await page.$eval(".bf-day-card.selected", (e) => e.getAttribute("data-day"))) === "Tue 13 Oct", days);
    check(tag + "a day with no times is labelled for screen readers", (await page.getAttribute('.bf-day-card[data-day="Wed 14 Oct"]', "aria-label")) === "Wed 14 Oct, no times available");
    check(tag + "Continue is off until a time is picked", await page.$eval("#btn-change-next", (b) => b.disabled));
    check(tag + "early-start box hidden before a time is chosen", await page.$eval("#early-row", (r) => r.hidden));

    // Early-start rule: homeowner, not given, day on or before the deadline (20 Oct)
    await page.click(".bf-slot-btn >> nth=1");
    check(tag + "early-start box shows for a homeowner moving inside the 14 days", await page.isVisible("#early-row"));
    check(tag + "early-start box has the booking form's exact wording", (await page.textContent("#early-row")).trim() === "I ask EasyClean Somerset to start my clean within my 14-day cancellation period. If I cancel after it starts, I’ll pay for the work done. Once it’s finished, I can’t cancel.", await page.textContent("#early-row"));
    check(tag + "Continue waits for the box", await page.$eval("#btn-change-next", (b) => b.disabled));
    await shot(page, "2-change", dark);
    await page.check("#early-start");
    check(tag + "ticking the box switches Continue on", !(await page.$eval("#btn-change-next", (b) => b.disabled)));
    // A day after the deadline (21 Oct) needs no box
    await page.click(".bf-days-nav-btn >> nth=1");
    await page.click('.bf-day-card[data-day="Wed 21 Oct"]');
    check(tag + "changing day clears the chosen time and hides the box", await page.$eval("#early-row", (r) => r.hidden) && (await page.$eval("#btn-change-next", (b) => b.disabled)));
    await page.click(".bf-slot-btn >> nth=0");
    check(tag + "no box for a day after the 14-day deadline, Continue is on", !(await page.isVisible("#early-row")) && !(await page.$eval("#btn-change-next", (b) => b.disabled)));

    // Confirm step
    await page.click("#btn-change-next");
    await waitState(page, "state-confirm-move");
    check(tag + "confirm step reads Move from [old] to [new]?", (await page.textContent("#move-question")) === "Move from Mon 12 Oct at 9:00am to Wed 21 Oct at 9:00am?", await page.textContent("#move-question"));
    await shot(page, "3-confirm-move", dark);
    fake.postReplies.push({ ok: true, date: "2026-10-21", time: "09:00", whenLabel: "Wed 21 Oct at 9:00am" });
    await page.click("#btn-move-yes");
    await waitState(page, "state-success-move");
    check(tag + "sends date, time and earlyStart for the move", JSON.stringify(fake.posts[0]) === JSON.stringify({ action: "reschedule", t: "MANAGE123", date: "2026-10-21", time: "09:00", earlyStart: false }), fake.posts);
    check(tag + "success screen shows the new time and says we emailed the details", (await page.textContent("#state-success-move")).includes("Wed 21 Oct at 9:00am") && (await page.textContent("#state-success-move")).includes("We’ve emailed you the details."));
    await shot(page, "4-success-move", dark);
    check(tag + "no pageerrors", fake.errors.length === 0, fake.errors);
    await context.close();
  }

  // earlyStart is sent true when the box was ticked
  {
    const { page, fake, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    await page.click("#btn-change");
    await page.waitForSelector(".bf-slot-btn");
    await page.click(".bf-slot-btn >> nth=0");
    await page.check("#early-start");
    await page.click("#btn-change-next");
    fake.postReplies.push({ ok: true, date: "2026-10-13", time: "09:00", whenLabel: "Tue 13 Oct at 9:00am" });
    await page.click("#btn-move-yes");
    await waitState(page, "state-success-move");
    check(tag + "earlyStart is true in the move when the box was ticked", fake.posts[0].earlyStart === true, fake.posts);
    await context.close();
  }

  // No early-start box: agent, or already given
  for (const [label, override] of [["agent", { channel: "agent", cancelDeadline: null }], ["homeowner who already ticked it", { earlyStartGiven: true }]]) {
    const { page, fake, context } = await open(browser, base, { dark, booking: Object.assign({}, BOOKING, override) });
    await waitState(page, "state-main");
    await page.click("#btn-change");
    await page.waitForSelector(".bf-slot-btn");
    await page.click(".bf-slot-btn >> nth=0");
    check(tag + "no early-start box for " + label, !(await page.isVisible("#early-row")) && !(await page.$eval("#btn-change-next", (b) => b.disabled)));
    await page.click("#btn-change-next");
    fake.postReplies.push({ ok: true, date: "2026-10-13", time: "09:00", whenLabel: "Tue 13 Oct at 9:00am" });
    await page.click("#btn-move-yes");
    await waitState(page, "state-success-move");
    check(tag + "earlyStart for " + label + " is " + (override.earlyStartGiven ? "true" : "false"), fake.posts[0].earlyStart === !!override.earlyStartGiven, fake.posts);
    await context.close();
  }

  // slot_taken: reload the times and say so
  {
    const { page, fake, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    await page.click("#btn-change");
    await page.waitForSelector(".bf-slot-btn");
    await page.click(".bf-slot-btn >> nth=0");
    await page.check("#early-start");
    await page.click("#btn-change-next");
    fake.postReplies.push({ ok: false, error: "slot_taken" });
    fake.slots = { ok: true, slots: SLOTS.slice(1) };
    await page.click("#btn-move-yes");
    await waitState(page, "state-change");
    await page.waitForFunction(() => document.getElementById("change-status").textContent.includes("taken"));
    check(tag + "slot_taken goes back to the picker and says the time was taken", (await page.textContent("#change-status")).includes("Sorry, that time has just been taken"));
    check(tag + "slot_taken reloads the times", fake.gets.filter((u) => u.includes("rescheduleSlots")).length === 2, fake.gets);
    check(tag + "the taken time is gone and nothing is selected", (await page.$$(".bf-slot-btn.selected")).length === 0 && (await page.$$eval(".bf-slot-btn", (b) => b.map((x) => x.textContent))).join() === "2:00pm");
    await shot(page, "5-slot-taken", dark);
    await context.close();
  }

  // no_moves_left from the move, and from the booking itself
  {
    const { page, fake, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    await page.click("#btn-change");
    await page.waitForSelector(".bf-slot-btn");
    await page.click(".bf-slot-btn >> nth=0");
    await page.check("#early-start");
    await page.click("#btn-change-next");
    fake.postReplies.push({ ok: false, error: "no_moves_left" });
    await page.click("#btn-move-yes");
    await waitState(page, "state-nomoves");
    check(tag + "no_moves_left shows the message-us state with WhatsApp and email", (await page.$$("#state-nomoves a[href^='https://wa.me/447873212249']")).length === 1 && (await page.$$("#state-nomoves a[href='mailto:easycleansomerset@gmail.com']")).length === 1);
    await shot(page, "6-no-moves", dark);
    await context.close();
  }
  {
    const { page, context } = await open(browser, base, { dark, booking: Object.assign({}, BOOKING, { movesLeft: 0 }) });
    await waitState(page, "state-main");
    check(tag + "with no moves left the Change button is replaced by a message-us note", (await page.isHidden("#btn-change")) && (await page.isVisible("#moves-note")) && (await page.isVisible("#btn-cancel")));
    await context.close();
  }

  // Cancel
  {
    const { page, fake, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    await page.click("#btn-cancel");
    await waitState(page, "state-confirm-cancel");
    check(tag + "cancel confirm reads Cancel your clean on [day] at [time]?", (await page.textContent("#cancel-question")) === "Cancel your clean on Mon 12 Oct at 9:00am?", await page.textContent("#cancel-question"));
    check(tag + "reasons are in a fieldset with a legend", (await page.textContent("#state-confirm-cancel legend")).includes("Why are you cancelling?"));
    check(tag + "reasons are Plans changed, Booked someone else, Price, Other", (await page.$$eval(".reason-btn", (b) => b.map((x) => x.textContent))).join() === "Plans changed,Booked someone else,Price,Other");
    check(tag + "buttons are Yes, cancel and Keep my booking", (await page.textContent("#btn-cancel-yes")) === "Yes, cancel" && (await page.textContent("#btn-cancel-no")) === "Keep my booking");
    await shot(page, "7-cancel-confirm", dark);
    await page.click("#btn-cancel-no");
    await waitState(page, "state-main");
    await page.click("#btn-cancel");
    await page.click('.reason-btn[data-reason="Price"]');
    check(tag + "the chosen reason is marked pressed", (await page.getAttribute('.reason-btn[data-reason="Price"]', "aria-pressed")) === "true");
    await page.click('.reason-btn[data-reason="Price"]');
    check(tag + "tapping it again clears it", (await page.getAttribute('.reason-btn[data-reason="Price"]', "aria-pressed")) === "false");
    await page.click('.reason-btn[data-reason="Plans changed"]');
    fake.postReplies.push({ ok: true });
    await page.click("#btn-cancel-yes");
    await waitState(page, "state-success-cancel");
    check(tag + "sends the cancel with token and reason", JSON.stringify(fake.posts[0]) === JSON.stringify({ action: "cancel", t: "MANAGE123", reason: "Plans changed" }), fake.posts);
    check(tag + "success screen says we emailed to confirm", (await page.textContent("#state-success-cancel")).includes("We’ve emailed you to confirm."));
    await shot(page, "8-success-cancel", dark);
    await context.close();
  }
  {
    const { page, fake, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    await page.click("#btn-cancel");
    fake.postReplies.push({ ok: true });
    await page.click("#btn-cancel-yes");
    await waitState(page, "state-success-cancel");
    check(tag + "cancelling with no reason sends an empty reason", fake.posts[0].reason === "", fake.posts);
    await context.close();
  }
  {
    const { page, fake, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    await page.click("#btn-cancel");
    fake.postReplies.push({ ok: false, error: "server_error" });
    await page.click("#btn-cancel-yes");
    await page.waitForFunction(() => !document.getElementById("cancel-status").hidden);
    check(tag + "a server error on cancel stays on the confirm step with a message", (await active(page)) === "state-confirm-cancel" && (await page.textContent("#cancel-status")).includes("hasn't been cancelled"));
    fake.postReplies.push({ ok: false, error: "started" });
    await page.click("#btn-cancel-yes");
    await waitState(page, "state-cant");
    check(tag + "an error saying it has started shows the can't-change state", (await page.textContent("#cant-text")).includes("has started"));
    await context.close();
  }

  // Not found, no token, can't change (three reasons), network failure
  {
    const { page, context } = await open(browser, base, { dark, booking: { ok: false, error: "not_found" } });
    await waitState(page, "state-notfound");
    check(tag + "not found says We couldn't find this booking, with WhatsApp and email", (await page.textContent("#h-notfound")) === "We couldn’t find this booking" && (await page.$$("#state-notfound a[href^='https://wa.me/']")).length === 1 && (await page.$$("#state-notfound a[href^='mailto:']")).length === 1);
    await shot(page, "9-not-found", dark);
    await context.close();
  }
  {
    const { page, fake, context } = await open(browser, base, { dark, noToken: true });
    await waitState(page, "state-notfound");
    check(tag + "no token in the link is the not-found state, with no request made", fake.gets.length === 0, fake.gets);
    await context.close();
  }
  for (const [reason, phrase] of [["cancelled", "has been cancelled"], ["completed", "signed off"], ["started", "has started"]]) {
    const { page, context } = await open(browser, base, { dark, booking: Object.assign({}, BOOKING, { canChange: false, notChangeableReason: reason }) });
    await waitState(page, "state-cant");
    check(tag + "can't change (" + reason + ") has its own sentence, WhatsApp and email, and no buttons", (await page.textContent("#cant-text")).includes(phrase) && (await page.$$("#state-cant a[href^='https://wa.me/']")).length === 1 && (await page.$$("#state-cant a[href^='mailto:']")).length === 1 && !(await page.isVisible("#btn-change")) && !(await page.isVisible("#btn-cancel")), await page.textContent("#cant-text"));
    if (reason === "cancelled") await shot(page, "10-cant-change", dark);
    await context.close();
  }
  {
    const { page, fake, context } = await open(browser, base, { dark });
    fake.bookingFails = true;
    await page.reload();
    await waitState(page, "state-error");
    fake.bookingFails = false;
    await page.click("#btn-retry");
    await waitState(page, "state-main");
    check(tag + "a network failure shows Try again, which loads the booking", true);
    await context.close();
  }

  // Page rules
  {
    const { page, context } = await open(browser, base, { dark });
    await waitState(page, "state-main");
    check(tag + "no fee wording on the page", !/fee|£25|charge/i.test(await page.evaluate(() => document.body.innerText + document.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, ""))));
    check(tag + "no horizontal scroll at 390px", await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    await context.close();
  }
}

(async () => {
  const server = await serve(siteDir);
  const base = "http://localhost:" + server.address().port + "/";
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  const html = fs.readFileSync(path.join(siteDir, "my-booking.html"), "utf8");
  check("page is noindex, nofollow", /<meta name="robots" content="noindex, nofollow">/.test(html));
  check("page is not in the sitemap", !/my-booking/.test(fs.readFileSync(path.join(siteDir, "sitemap.xml"), "utf8")));
  check("page has no em dashes", !html.includes("—") && !html.includes("&mdash;"));

  await run(browser, base, false);
  await run(browser, base, true);

  const terms = fs.readFileSync(path.join(siteDir, "terms.html"), "utf8");
  check("terms section 5 has the new wording", terms.includes("To cancel or reschedule, use the Change or cancel button in your booking emails, message us on WhatsApp, or reply to your confirmation email."));
  check("terms section 11 says the form is attached", terms.includes("You can use the cancellation form attached to your confirmation email, but you don&rsquo;t have to. If you cancel using the button in your emails, we&rsquo;ll email to confirm we&rsquo;ve received it."));
  check("terms fee wording is unchanged", terms.includes("a £25 cancellation/call-out fee applies"));

  await browser.close();
  server.close();
  console.log(failures ? "\n" + failures + " check(s) FAILED" : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})();
