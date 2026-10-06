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
// The page's clock is fixed at 1 Oct 2026 (or `now`), so the fake times on
// 5 and 6 Oct are inside the 14-day cancellation period.
async function openPage(browser, url, contextOptions, now) {
  const context = await browser.newContext(contextOptions);
  await context.clock.setFixedTime(new Date(now || "2026-10-01T09:00:00Z"));
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
  // Every calendar day shows, even with no times. The page's clock is Thu 1 Oct, the fake times
  // are Mon 5 and Tue 6 Oct only, so Fri 2, Sat 3 and Sun 4 have none.
  const cards = () => page.$$eval(".bf-day-card", (els) => els.map((e) => ({ day: e.getAttribute("data-day"), empty: e.classList.contains("no-times"), selected: e.classList.contains("selected") })));
  const first = await cards();
  check("the days run on without gaps, so Friday is followed by Saturday, Sunday, then Monday", JSON.stringify(first.slice(0, 5).map((c) => c.day)) === JSON.stringify(["Fri 2 Oct", "Sat 3 Oct", "Sun 4 Oct", "Mon 5 Oct", "Tue 6 Oct"]), first.map((c) => c.day));
  check("a week of days shows at a time", first.length === 7, first.length);
  check("days with no times are marked, days with times are not", first.every((c) => c.empty === !["Mon 5 Oct", "Tue 6 Oct"].includes(c.day)), first);
  check("the first day with times is the one selected", first.find((c) => c.selected).day === "Mon 5 Oct", first);
  check("a day with no times says so to screen readers", (await page.getAttribute('.bf-day-card[data-day="Sun 4 Oct"]', "aria-label")) === "Sun 4 Oct, no times available");
  await page.click('.bf-day-card[data-day="Sun 4 Oct"]');
  check("clicking a Sunday shows that it has no times", (await page.textContent("#bf-slots-label")) === "No times on Sun 4 Oct" && (await page.$$(".bf-slot-btn")).length === 0, await page.textContent("#bf-slots-label"));
  check("and offers WhatsApp instead", (await page.textContent("#bf-slots")).includes("WhatsApp"));
  await page.click(".bf-days-nav-btn >> nth=1");
  await page.click(".bf-days-nav-btn >> nth=0");
  await page.click('.bf-day-card[data-day="Mon 5 Oct"]');
  check("clicking a day with times shows them again", (await page.$$(".bf-slot-btn")).length === 1);

  // The form runs postcode, time, contact details, payment, then the closed extras.
  const order = await page.evaluate((agents) => {
    const ids = ["bf-postcode", "bf-days", "bf-name", "bf-phone", "bf-email", "bf-address"].concat(agents ? ["bf-access-note"] : []).concat(["bf-extras", "bf-submit"]);
    const els = ids.map((id) => document.getElementById(id));
    return els.every((el, i) => i === 0 || !!(els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  }, agents);
  check("form order: postcode, time, contact details, then the extras", order);
  check("address box is for the street only (the postcode is asked first)", /street/i.test(await page.textContent('label[for="bf-address"]')));
  if (!agents) check("payment starts on Cash", await page.isChecked('input[name="bf-payment"][value="Cash"]'));

  // The postcode comes first, and the area check answers before anything else is typed.
  await page.fill("#bf-postcode", "SW1A 1AA");
  check("postcode outside the area offers WhatsApp straight away", (await page.textContent("#bf-area-msg")).includes("SW1A") && (await page.$$("#bf-area-msg a.btn-wa")).length === 1);
  await page.fill("#bf-postcode", "BA1 1");
  check("a part-typed postcode shows no area note", !(await page.isVisible("#bf-area-msg")));
  await page.fill("#bf-postcode", "BA1 1AA");
  check("a postcode we cover shows no area note", !(await page.isVisible("#bf-area-msg")));
  await page.fill("#bf-postcode", "SW1A 1AA");

  // Confirm only switches on when everything needed is there.
  await page.click(".bf-slot-btn >> nth=0");
  await page.fill("#bf-name", "Test Person");
  await page.fill("#bf-phone", "07000 000000");
  await page.fill("#bf-email", "test@example.com");
  await page.fill("#bf-address", "1 High Street");
  check("Confirm stays off outside the area", await confirmOff());
  await page.fill("#bf-postcode", "ba11aa");
  await page.focus("#bf-name");
  check("postcode is tidied when leaving the box", (await page.inputValue("#bf-postcode")) === "BA1 1AA");
  if (agents) {
    check("agent page: 'We'll arrange access' is the default", await page.isChecked('input[name="bf-access"][value="arrange"]'));
    check("agent page: the site contact boxes start hidden and not required", await page.$eval("#bf-site-contact", (el) => getComputedStyle(el).display === "none") && (await page.$eval("#bf-site-contact-name", (e) => !e.required)));
    await page.check('input[name="bf-access"][value="onsite"]');
    check("agent page: 'Someone will be there' shows the site contact boxes", await page.isVisible("#bf-site-contact-name") && await page.isVisible("#bf-site-contact-phone"));
    check("agent page: Confirm waits for the site contact when someone will be there", await confirmOff());
    await page.fill("#bf-site-contact-name", "Site Person");
    await page.fill("#bf-site-contact-phone", "07111 111111");
    check("agent page: Confirm switches on once the site contact is filled in", !(await confirmOff()));
    await page.check('input[name="bf-access"][value="arrange"]');
    check("agent page: arranging access hides the site contact boxes again", await page.$eval("#bf-site-contact", (el) => getComputedStyle(el).display === "none"));
  }
  check("terms link by Confirm", (await page.$$('.bf-terms a[href="terms.html"]')).length === 1);
  if (!agents) {
    check("a time within 14 days shows the early-start box", await page.isVisible("#bf-early-start"));
    check("Confirm waits for the early-start box", await confirmOff());
    await page.check("#bf-early-start");
  } else {
    check("agent page: no early-start box", (await page.$("#bf-early-start")) === null);
  }
  check("Confirm switches on once everything is filled in", !(await confirmOff()));
  if (agents) {
    await page.fill("#bf-business", "Acme Lettings");
    await page.fill("#bf-business", "");
    check("agent page: business name is optional (private landlords)", !(await confirmOff()));
    await page.fill("#bf-business", "Acme Lettings");
  }

  // The extras start closed and out of sight. The summary is a real keyboard control.
  check("the extras start closed", (await page.$eval("#bf-extras", (d) => !d.open)) && !(await page.isVisible("#bf-notes")) && !(await page.isVisible('input[name="bf-parking"]')));
  check("the extras link says what is inside", (await page.textContent("#bf-extras summary")).startsWith("Anything else? (parking, pets,"));
  check("the extras hold parking, notes and the " + (agents ? "reference" : "referral code"),
    await page.$$eval("#bf-extras", (d, id) => ["bf-notes", id].every((x) => d[0].querySelector("#" + x)) && d[0].querySelectorAll('input[name="bf-parking"]').length === 3, agents ? "bf-agency-id" : "bf-referral"));
  await page.focus("#bf-extras summary");
  await page.keyboard.press("Enter");
  check("the extras open from the keyboard", (await page.$eval("#bf-extras", (d) => d.open)) && (await page.isVisible("#bf-notes")));
  await page.keyboard.press("Enter");
  check("and close again", await page.$eval("#bf-extras", (d) => !d.open));

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
  await page.click("#bf-extras summary");
  if (!agents) {
    await page.check('input[name="bf-payment"][value="Bank transfer"]');
    await page.fill("#bf-referral", "FRIEND10");
    await page.check('input[name="bf-parking"][value="Permit zone, visitor permit provided"]');
    await page.fill("#bf-notes", "Dog in the kitchen.\nStain by the sofa.");
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
  if (agents) check("parking and notes are optional", sent.parking === "" && sent.notes === "", [sent.parking, sent.notes]);
  else check("booking sends the parking answer and notes", sent.parking === "Permit zone, visitor permit provided" && sent.notes === "Dog in the kitchen.\nStain by the sofa.", [sent.parking, sent.notes]);
  if (agents) {
    check("agent booking: channel and invoice payment", sent.channel === "Agent/Landlord" && sent.payment === "Invoice, 14 days");
    check("agent booking: business, account reference and arranged access", sent.businessName === "Acme Lettings" && sent.agencyId === "REF-9" && sent.accessArrange === true && sent.siteContactName === "" && sent.siteContactPhone === "");
    check("agent booking: no homeowner-only fields", !("referralCode" in sent) && !("earlyStart" in sent));
  } else {
    check("homeowner booking: channel and chosen payment", sent.channel === "Consumer" && sent.payment === "Bank transfer");
    check("homeowner booking: referral code, no agent-only fields", sent.referralCode === "FRIEND10" && !("businessName" in sent) && !("accessArrange" in sent));
    check("homeowner booking: sends the early-start request", sent.earlyStart === true, sent.earlyStart);
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
  await page.focus('.bf-day-card[data-day="Sun 4 Oct"]');
  await page.keyboard.press("Enter");
  check("a day with no times is read out when picked", await waitToHear("No times on Sun 4 Oct"), await spoken());
  check("and focus stays on it", (await focused()).day === "Sun 4 Oct");
  await page.focus('.bf-day-card[data-day="Tue 6 Oct"]');
  await page.keyboard.press("Enter");
  await page.focus(".bf-slot-btn >> nth=0");
  await page.keyboard.press("Enter");
  const time = await focused();
  check("picking a time keeps focus on that time", time.cls.includes("bf-slot-btn") && time.pressed === "true", time);
  if (!agents) check("the early-start box is read out when it appears", await waitToHear("14-day cancellation period"), await spoken());

  const legends = await page.$$eval("fieldset > legend", (els) => els.map((e) => e.textContent.trim()));
  const parking = "Is there parking, or a visitor permit? (optional)";
  const expected = agents ? ["Choose a time", "Access on the day", parking] : ["Choose a time", "How would you like to pay?", parking];
  check("choice groups have a fieldset and legend", JSON.stringify(legends) === JSON.stringify(expected), legends);

  // The extras link is a details/summary, so its open or closed state is read out natively.
  const summaryRole = await page.$eval("#bf-extras summary", (el) => ({ tag: el.tagName, parent: el.parentElement.tagName, tabindex: el.tabIndex }));
  check("the extras link is a real summary in a details box, reachable by Tab", summaryRole.tag === "SUMMARY" && summaryRole.parent === "DETAILS" && summaryRole.tabindex >= 0, summaryRole);
  await page.focus("#bf-extras summary");
  await page.keyboard.press("Space");
  check("the extras open with Space", await page.$eval("#bf-extras", (d) => d.open));
  await page.keyboard.press("Space");

  await page.fill("#bf-postcode", "SW1A 1AA");
  check("out-of-area note is read out", await waitToHear("We don’t take online bookings"), await spoken());
  await page.fill("#bf-postcode", "BA1 1AA");
  await page.fill("#bf-name", "Test Person");
  if (agents) await page.fill("#bf-business", "Acme Lettings");
  await page.fill("#bf-phone", "07000 000000");
  await page.fill("#bf-email", "test@example.com");
  await page.fill("#bf-address", "1 High Street");
  if (!agents) await page.check("#bf-early-start");

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

// A clean after the 14-day cancellation period needs no early-start box.
async function laterClean(browser, base) {
  console.log("\n== index.html (clean after 14 days)");
  const { page, fake, context } = await openPage(browser, base + "index.html", undefined, "2026-09-01T09:00:00Z");
  await page.click('#group-rooms .item-row:nth-child(1) button[data-action="inc"]');
  await page.click("#bf-slots-retry");
  await page.waitForSelector(".bf-day-card");
  await page.fill("#bf-postcode", "BA1 1AA");
  await page.click(".bf-slot-btn >> nth=0");
  await page.fill("#bf-name", "Test Person");
  await page.fill("#bf-phone", "07000 000000");
  await page.fill("#bf-email", "test@example.com");
  await page.fill("#bf-address", "1 High Street");
  check("no early-start box for a clean after 14 days", !(await page.isVisible("#bf-early-start")));
  check("Confirm switches on without opening the extras", !(await page.$eval("#bf-submit", (b) => b.disabled)));
  fake.replies.push({ ok: true, reference: "EC-TEST3" });
  await page.click("#bf-submit");
  await page.waitForSelector("#booking-confirmed .ref");
  const sent = fake.bookings[fake.bookings.length - 1];
  check("booking says no early start was asked for", sent.earlyStart === false);
  check("with the extras left closed, the booking sends the same fields, empty", sent.parking === "" && sent.notes === "" && sent.referralCode === "" && sent.payment === "Cash" && sent.address === "1 High Street, BA1 1AA", sent);
  await context.close();
}

// A browser that restores typed values (Back, reload) must not hide them in the closed extras.
async function restoredExtras(browser, base, file) {
  const agents = file === "agents.html";
  console.log("\n== " + file + " (values restored by the browser)");
  const { page, context } = await openPage(browser, base + file);
  await page.click('#group-rooms .item-row:nth-child(1) button[data-action="inc"]');
  check("extras closed before anything is restored", await page.$eval("#bf-extras", (d) => !d.open));
  await page.evaluate((agents) => {
    document.getElementById("bf-notes").value = "Gate code 1234";
    if (!agents) document.getElementById("bf-referral").value = "FRIEND10";
    document.getElementById("bf-postcode").value = "SW1A 1AA";
    window.dispatchEvent(new Event("pageshow"));
  }, agents);
  check("extras open when notes were restored", await page.$eval("#bf-extras", (d) => d.open));
  check("a restored postcode outside the area shows the WhatsApp offer", await page.isVisible("#bf-area-msg a.btn-wa"));
  await context.close();
  const again = await openPage(browser, base + file);
  await again.page.click('#group-rooms .item-row:nth-child(1) button[data-action="inc"]');
  await again.page.evaluate(() => {
    document.querySelector('input[name="bf-parking"]').checked = true;
    window.dispatchEvent(new Event("pageshow"));
  });
  check("extras open when a parking answer was restored", await again.page.$eval("#bf-extras", (d) => d.open));
  await again.context.close();
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
    await laterClean(browser, base);
    await restoredExtras(browser, base, "index.html");
    await restoredExtras(browser, base, "agents.html");
    await accessibility(browser, base, "index.html");
    await accessibility(browser, base, "agents.html");
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
