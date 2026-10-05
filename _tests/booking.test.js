/*
 * Browser check of the booking flow on index.html and agents.html.
 *
 * The booking system (Apps Script) is faked, so nothing reaches the real
 * calendar, and the cookie banner is answered "Reject" so nothing is sent
 * to Google Analytics. Run it before and after any change to booking.js or
 * either booking form.
 *
 * From the repo root:
 *   jekyll build                    builds the site into _site/
 *   cd _tests && npm install && npx playwright install chromium && cd ..
 *   node _tests/booking.test.js     or: node _tests/booking.test.js path/to/site
 *
 * Prints PASS/FAIL per check and exits non-zero if anything failed.
 * This folder starts with "_", so it is never published with the site.
 */
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const siteDir = path.resolve(process.argv[2] || "_site");

const SLOTS = [
  { start: "2026-10-05T08:00:00Z", dayLabel: "Mon 5 Oct", timeLabel: "9:00am" },
  { start: "2026-10-06T08:00:00Z", dayLabel: "Tue 6 Oct", timeLabel: "9:00am" },
  { start: "2026-10-06T13:00:00Z", dayLabel: "Tue 6 Oct", timeLabel: "2:00pm" },
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
      if (!file.startsWith(dir) || !fs.existsSync(file)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, () => resolve(server));
  });
}

// Opens a page with the booking system faked. The first request for times
// fails, to check the Try again button. Bookings get the queued replies.
async function openPage(browser, url, contextOptions) {
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    try { localStorage.setItem("ecCookieConsent", JSON.stringify({ v: "denied", t: Date.now() })); } catch (e) {}
  });
  const page = await context.newPage();
  const fake = { bookings: [], replies: [], errors: [], timeRequests: 0 };
  page.on("pageerror", (e) => fake.errors.push(e.message));
  await page.route(/script\.google\.com/, (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      fake.timeRequests++;
      if (fake.timeRequests === 1) return route.fulfill({ status: 500, body: "down" });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, slots: SLOTS }) });
    }
    fake.bookings.push(JSON.parse(req.postData()));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(fake.replies.shift()) });
  });
  await page.route(/googletagmanager|fonts\.g|trustpilot/, (route) => route.abort());
  await page.goto(url);
  return { page, fake, context };
}

async function bookingPage(browser, base, file) {
  const agents = file === "agents.html";
  console.log("\n== " + file);
  const { page, fake, context } = await openPage(browser, base + file);
  const confirmOff = () => page.$eval("#bf-submit", (b) => b.disabled);
  const href = (sel) => page.$eval(sel, (a) => decodeURIComponent(a.getAttribute("href")));

  // Basket
  check("Continue to booking is off with an empty basket", await page.$eval("#btn-continue-book", (a) => a.getAttribute("aria-disabled") === "true"));
  await page.click('#group-rooms .item-row:nth-child(1) button[data-action="inc"]');
  await page.click('#group-rooms .item-row:nth-child(1) button[data-action="inc"]');
  await page.click('#group-sofas .item-row:nth-child(1) button[data-action="inc"]');
  check("basket total adds up (2 small rooms + armchair)", (await page.textContent("#summary-total")) === "£95", await page.textContent("#summary-total"));
  check("job time includes the 45 min overhead", (await page.textContent("#summary-time-val")) === "~1h 55m", await page.textContent("#summary-time-val"));
  check("Quick Quote link carries the basket", (await href("#btn-continue-wa")).includes("2× Small room: £70, 1× Armchair: £25. Total from your website: £95."));
  check("WhatsApp wording matches the page", (await href("#nav-wa")).includes("landlord/agent") === agents);

  // Available times: the first request fails, Try again loads them.
  await page.waitForSelector("#bf-slots-retry");
  await page.click("#bf-slots-retry");
  await page.waitForSelector(".bf-day-card");
  check("Try again loads the available days", (await page.$$(".bf-day-card")).length === 2);

  // Confirm only switches on when everything needed is there.
  await page.click(".bf-slot-btn >> nth=0");
  await page.fill("#bf-name", "Test Person");
  if (agents) await page.fill("#bf-business", "Acme Lettings");
  await page.fill("#bf-phone", "07000 000000");
  await page.fill("#bf-email", "test@example.com");
  await page.fill("#bf-address", "1 High Street");
  check("Confirm stays off without a postcode", await confirmOff());
  await page.fill("#bf-postcode", "SW1A 1AA");
  check("postcode outside the area offers WhatsApp", (await page.textContent("#bf-area-msg")).includes("SW1A") && (await page.$$("#bf-area-msg a.btn-wa")).length === 1);
  check("Confirm stays off outside the area", await confirmOff());
  await page.fill("#bf-postcode", "ba11aa");
  await page.focus("#bf-name");
  check("postcode is tidied when leaving the box", (await page.inputValue("#bf-postcode")) === "BA1 1AA");
  if (agents) {
    check("agent page: Confirm stays off until the site contact is filled in", await confirmOff());
    await page.check('input[name="bf-access"][value="arrange"]');
    check("agent page: arranging access hides the site contact boxes", await page.$eval("#bf-site-contact", (el) => el.style.display === "none"));
  }
  check("Confirm switches on once everything is filled in", !(await confirmOff()));
  if (agents) {
    await page.fill("#bf-business", "");
    check("agent page: Confirm goes off without a business name", await confirmOff());
    await page.fill("#bf-business", "Acme Lettings");
  }

  // Changing day drops a time picked on another day.
  await page.click('.bf-day-card[data-day="Tue 6 Oct"]');
  check("switching day clears the chosen time", (await confirmOff()) && (await page.$$(".bf-slot-btn.selected")).length === 0);
  await page.click(".bf-slot-btn >> text=2:00pm");

  // "That time was just taken"
  fake.replies.push({ ok: false, error: "slot_taken" });
  await page.click("#bf-submit");
  await page.waitForFunction(() => document.getElementById("bf-status").textContent.includes("just taken"));
  await page.waitForSelector(".bf-slot-btn");
  check("after a slot is taken, Confirm stays off until a new time", await confirmOff());
  await page.click(".bf-slot-btn >> text=9:00am");

  // A booking that fails offers WhatsApp with the details filled in.
  fake.replies.push({ ok: false, error: "something_else" });
  await page.click("#bf-submit");
  await page.waitForFunction(() => document.getElementById("bf-status").textContent.includes("went wrong"));
  check("a failed booking offers WhatsApp with the details", (await href("#bf-status a")).includes("Test Person") && !(await confirmOff()));

  // A booking that goes through.
  fake.replies.push({ ok: true, reference: "EC-TEST1" });
  if (!agents) {
    await page.check('input[name="bf-payment"][value="Bank transfer"]');
    await page.fill("#bf-referral", "FRIEND10");
  } else {
    await page.fill("#bf-agency-id", "REF-9");
  }
  await page.click("#bf-submit");
  await page.waitForSelector("#booking-confirmed .ref");
  check("confirmation shows the reference", (await page.textContent("#booking-confirmed .ref")) === "EC-TEST1");
  check("URL changes to #booked for Analytics", (await page.evaluate(() => location.hash)) === "#booked");

  const sent = fake.bookings[fake.bookings.length - 1];
  check("booking sends the chosen time", sent.startTime === "2026-10-06T08:00:00Z" && sent.slotLabel === "Tue 6 Oct, 9:00am", [sent.startTime, sent.slotLabel]);
  check("booking sends the basket for re-pricing", JSON.stringify(sent.lineItems) === JSON.stringify([{ item: "Small room", qty: 2 }, { item: "Armchair", qty: 1 }]), sent.lineItems);
  check("booking sends the full address with postcode", sent.address === "1 High Street, BA1 1AA" && sent.postcode === "BA1 1AA");
  if (agents) {
    check("agent booking: channel and invoice payment", sent.channel === "Agent/Landlord" && sent.payment === "Invoice, 14 days");
    check("agent booking: business, account reference and arranged access", sent.businessName === "Acme Lettings" && sent.agencyId === "REF-9" && sent.accessArrange === true && sent.siteContactName === "" && sent.siteContactPhone === "");
    check("agent booking: no homeowner-only fields", !("referralCode" in sent));
  } else {
    check("homeowner booking: channel and chosen payment", sent.channel === "Consumer" && sent.payment === "Bank transfer");
    check("homeowner booking: referral code, no agent-only fields", sent.referralCode === "FRIEND10" && !("businessName" in sent) && !("accessArrange" in sent));
  }
  check("no JavaScript errors", fake.errors.length === 0, fake.errors);
  await context.close();
}

// Keyboard and screen reader behaviour (FRE-196).
async function accessibility(browser, base, file) {
  const agents = file === "agents.html";
  console.log("\n== " + file + " (accessibility)");
  const { page, fake, context } = await openPage(browser, base + file);
  const spoken = () => page.evaluate(() => {
    const el = document.querySelector('body > div[aria-live="polite"]');
    return el ? el.textContent : null;
  });
  const waitToHear = (text) => page.waitForFunction((t) => {
    const el = document.querySelector('body > div[aria-live="polite"]');
    return el && el.textContent.includes(t);
  }, text, { timeout: 3000 }).then(() => true, () => false);
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    return { id: el.id, cls: el.className, day: el.getAttribute("data-day"), pressed: el.getAttribute("aria-pressed") };
  });

  check("page language is en-GB", (await page.getAttribute("html", "lang")) === "en-GB");
  await page.keyboard.press("Tab");
  check("first Tab reaches the skip link", (await page.evaluate(() => document.activeElement.getAttribute("href"))) === "#main" && (await page.$("main#main")) !== null);

  const toggle = "#carpet-cleaning h3 > button.item-group-toggle";
  const hasToggle = (await page.$(toggle)) !== null;
  check("group headings are real buttons inside headings", hasToggle);
  if (hasToggle) {
    await page.focus(toggle);
    await page.keyboard.press("Enter");
    check("group heading button collapses from the keyboard", (await page.getAttribute(toggle, "aria-expanded")) === "false");
    await page.keyboard.press("Space");
    check("and opens again", (await page.getAttribute(toggle, "aria-expanded")) === "true");
  }

  await page.click('#group-rooms .item-row:nth-child(1) button[data-action="inc"]');
  check("basket change is read out", await waitToHear("Small room: 1. Total £35."), await spoken());

  await page.click("#bf-slots-retry");
  await page.waitForSelector(".bf-day-card");
  await page.focus('.bf-day-card[data-day="Tue 6 Oct"]');
  await page.keyboard.press("Enter");
  const day = await focused();
  check("picking a day keeps focus on that day", day.day === "Tue 6 Oct" && day.pressed === "true", day);
  await page.focus(".bf-slot-btn >> nth=0");
  await page.keyboard.press("Enter");
  const time = await focused();
  check("picking a time keeps focus on that time", time.cls.includes("bf-slot-btn") && time.pressed === "true", time);

  const legends = await page.$$eval("fieldset > legend", (els) => els.map((e) => e.textContent.trim()));
  const expected = agents ? ["Access on the day", "Choose a time"] : ["How would you like to pay?", "Choose a time"];
  check("choice groups have a fieldset and legend", JSON.stringify(legends) === JSON.stringify(expected), legends);

  await page.fill("#bf-name", "Test Person");
  if (agents) await page.fill("#bf-business", "Acme Lettings");
  await page.fill("#bf-phone", "07000 000000");
  await page.fill("#bf-email", "test@example.com");
  await page.fill("#bf-address", "1 High Street");
  if (agents) await page.check('input[name="bf-access"][value="arrange"]');
  await page.fill("#bf-postcode", "SW1A 1AA");
  check("out-of-area note is read out", await waitToHear("We don’t take online bookings"), await spoken());
  await page.fill("#bf-postcode", "BA1 1AA");

  fake.replies.push({ ok: false, error: "something_else" });
  await page.click("#bf-submit");
  check("a failed booking is read out", await waitToHear("Something went wrong"), await spoken());
  fake.replies.push({ ok: true, reference: "EC-TEST2" });
  await page.click("#bf-submit");
  await page.waitForSelector("#booking-confirmed .ref");
  check("focus moves to the confirmation", (await focused()).id === "booking-confirmed");
  check("no JavaScript errors", fake.errors.length === 0, fake.errors);
  await context.close();

  // With "reduce motion" on, the scripted scrolling jumps instead of gliding.
  const still = await openPage(browser, base + file, { reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  await still.page.click("header .book-link");
  const y1 = await still.page.evaluate(() => window.scrollY);
  await still.page.waitForTimeout(600);
  const y2 = await still.page.evaluate(() => window.scrollY);
  check("reduced motion: Book online jumps straight to the prices", y1 > 0 && y1 === y2, [y1, y2]);
  await still.context.close();
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
    await bookingPage(browser, base, "index.html");
    await bookingPage(browser, base, "agents.html");
    await accessibility(browser, base, "index.html");
    await accessibility(browser, base, "agents.html");
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
