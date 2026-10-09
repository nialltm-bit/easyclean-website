/*
 * FRE-203 and FRE-195: jobs dragged in Google Calendar, repeat customers,
 * the site contact WhatsApp reminder, and marketing opt-in consent and
 * unsubscribes.
 *
 * From the repo root:
 *   node _tests/customers-and-contacts.test.js
 *
 * Runs Code.gs with Google's services faked (see fake-google.js). Needs no
 * npm install. Apps Script runs in UK time, so this does too.
 */
process.env.TZ = "Europe/London";
const { loadBackend } = require("./fake-google");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || detail === undefined ? "" : "  (" + JSON.stringify(detail) + ")"));
  if (!ok) failures++;
}

// Thu 8 Oct 2026, 10:00am UK time.
const NOW = "2026-10-08T09:00:00Z";
function setup(now) {
  const b = loadBackend({ now: now || NOW });
  b.setUpSheet();
  return b;
}
const refOf = (e) => (/Reference: (EC-\d+)/.exec(e.description || "") || [])[1];
const eventFor = (b, ref) => b.state.events.filter((e) => refOf(e) === ref)[0];
const ownerMails = (b) => b.state.emails.filter((e) => e.to === "owner@example.com");
const plainOk = (b, x, where) => { try { b.checkPlain(x, where); return true; } catch (e) { return false; } };
function web(b, extra, slotIndex) {
  const slot = b.ctx.getAvailableSlots()[slotIndex || 5];
  return b.ctx.createBooking(Object.assign({
    startTime: slot.start, name: "Sam Customer", phone: "07000 000001", email: "sam@example.com", address: "1 High Street",
    postcode: "BA3 2AA", items: "1× Medium room: £45", total: "£45", estTime: "~1h 25m", payment: "Cash", channel: "Consumer",
    slotLabel: "x", lineItems: [{ item: "Medium room", qty: 1 }], earlyStart: true,
  }, extra || {}));
}

// ================= Dragged in Google Calendar =================
(function dragged() {
  console.log("\n== A job dragged to a new time in Google Calendar");
  const b = setup(); const c = b.ctx;
  b.addBooking({ Reference: "EC-10001", "Booking time": "Mon 12 Oct, 9:00am", "Starts at": b.date("2026-10-12T08:00:00Z"), "Ends at": b.date("2026-10-12T10:30:00Z"),
    "Day-before reminder sent": "" }, "2026-10-12T08:00:00Z");
  b.addBooking({ Reference: "EC-10002", "Booking time": "Tue 13 Oct, 9:00am", "Starts at": b.date("2026-10-13T08:00:00Z"), "Ends at": b.date("2026-10-13T10:30:00Z"),
    "Day-before reminder sent": b.date("2026-10-12T06:00:00Z"), "Day-of reminder sent": b.date("2026-10-13T06:00:00Z") }, "2026-10-13T08:00:00Z");
  b.addBooking({ Reference: "EC-10003", "Booking time": "Wed 14 Oct, 9:00am" }, "2026-10-14T08:00:00Z"); // older booking, no saved time

  // Same day, later time.
  eventFor(b, "EC-10001").setTime(b.date("2026-10-12T12:00:00Z"), b.date("2026-10-12T14:30:00Z"));
  // Another day.
  eventFor(b, "EC-10002").setTime(b.date("2026-10-16T09:00:00Z"), b.date("2026-10-16T11:30:00Z"));

  const n = c.syncOpenBookingTimes_();
  check("the sync picks up both moves and the older booking", n === 3, n);
  let r = b.row("EC-10001");
  check("Booking time text shows the new time", r["Booking time"] === "Mon 12 Oct, 1:00pm", r["Booking time"]);
  check("Starts at and Ends at follow it", r["Starts at"].toISOString() === "2026-10-12T12:00:00.000Z" && r["Ends at"].toISOString() === "2026-10-12T14:30:00.000Z");
  check("the move is noted in Changes", /8 Oct: moved in the calendar from Mon 12 Oct, 9:00am to Mon 12 Oct, 1:00pm/.test(r.Changes), r.Changes);
  r = b.row("EC-10002");
  check("moved to another day: new text", r["Booking time"] === "Fri 16 Oct, 10:00am", r["Booking time"]);
  check("and its reminders can go again on the new dates", r["Day-before reminder sent"] === "" && r["Day-of reminder sent"] === "", [r["Day-before reminder sent"], r["Day-of reminder sent"]]);
  r = b.row("EC-10003");
  check("an older booking gets its time saved", r["Starts at"].toISOString() === "2026-10-14T08:00:00.000Z" && r["Booking time"] === "Wed 14 Oct, 9:00am");
  check("without a 'moved' note, since it didn't move", !/moved/.test(r.Changes || ""), r.Changes);
  check("running again changes nothing", c.syncOpenBookingTimes_() === 0);

  // The daily run syncs first, so tomorrow's reminder goes to the moved job.
  const d = setup("2026-10-11T06:00:00Z"); const dc = d.ctx; // Sun 11 Oct, 7am
  d.addBooking({ Reference: "EC-20001", Email: "pat@example.com", Timestamp: d.date("2026-10-01T09:00:00Z"),
    "Starts at": d.date("2026-10-15T08:00:00Z"), "Ends at": d.date("2026-10-15T10:30:00Z"), "Day-before reminder sent": d.date("2026-10-08T06:00:00Z") }, "2026-10-15T08:00:00Z");
  eventFor(d, "EC-20001").setTime(d.date("2026-10-12T08:00:00Z"), d.date("2026-10-12T10:30:00Z")); // pulled forward to Mon
  dc.sendDayOfReminders();
  const mail = d.sentTo("pat@example.com").filter((m) => /tomorrow|Tomorrow/.test(m.subject + m.body))[0];
  check("the daily run sends the day-before reminder for the new day", !!mail && /Mon 12 Oct/.test(mail.body), d.sentTo("pat@example.com").map((m) => m.subject));
  check("and the sheet text is updated", d.row("EC-20001")["Booking time"] === "Mon 12 Oct, 9:00am");
})();

// ================= Repeat customers =================
(function repeats() {
  console.log("\n== Repeat customers");
  const b = setup(); const c = b.ctx;
  check("phone numbers match in any format", c.phoneKey_("07700 900000") === "07700900000" && c.phoneKey_("+44 7700 900000") === "07700900000" &&
    c.phoneKey_("447700900000") === "07700900000" && c.phoneKey_(7700900000) === "07700900000" && c.phoneKey_("12345") === "");
  check("emails match ignoring case and spaces", c.emailKey_(" Sam@Example.com ") === "sam@example.com" && c.emailKey_("nope") === "");

  const first = web(b, {}, 5);
  check("first booking made", first.ok, first);
  let alert = ownerMails(b).filter((m) => /New booking/.test(m.subject)).pop();
  check("a first booking has no 'Booked before' line", alert && alert.body.indexOf("Booked before") === -1);

  b.addBooking({ Reference: "EC-50001", Email: "SAM@example.com", Phone: "", Total: "£90", "Completed at": b.date("2026-09-10T12:00:00Z"), "Starts at": b.date("2026-09-10T08:00:00Z") });
  b.addBooking({ Reference: "EC-50002", Email: "other@example.com", Phone: "+44 7000 000001", Total: "£40", "Cancelled at": b.date("2026-09-20T12:00:00Z"), "Starts at": b.date("2026-09-25T08:00:00Z") });
  b.addBooking({ Reference: "EC-50003", Email: "stranger@example.com", Phone: "07999 999999", Total: "£60" });
  const second = web(b, {}, 20);
  alert = ownerMails(b).filter((m) => /New booking/.test(m.subject)).pop();
  check("a repeat booking's email says so", alert && alert.body.indexOf("Booked before: 3 other bookings (1 done, 1 still booked, 1 cancelled). Latest: " + first.reference) !== -1, alert && alert.body);

  const job = c.adminGetJob(b.row(second.reference)["Job token"]);
  check("the job page lists earlier bookings, newest first", job.historyCount === 3 && job.history.map((h) => h.reference).join() === [first.reference, "EC-50002", "EC-50001"].join(), job.history);
  check("with date, total and status", job.history[2].when === "Thu 10 Sep 2026" && job.history[2].total === "£90" && job.history[2].status === "Done" &&
    job.history[1].status === "Cancelled", job.history);
  check("and a token to open each one", job.history.every((h) => /^[0-9a-f]{32}$/.test(h.token)));
  check("no Dates in the job page data", plainOk(b, job, "adminGetJob"));
  check("matched by phone when the email differs", job.history.some((h) => h.reference === "EC-50002"));
  check("a stranger isn't included", !job.history.some((h) => h.reference === "EC-50003"));

  const o = c.adminGetOverview();
  const cards = o.upcoming.concat(o.waiting, o.today);
  const flag = (ref) => (cards.filter((j) => j.reference === ref)[0] || {}).repeat === true;
  check("job cards mark later bookings as booked before", flag(second.reference) && !flag(first.reference), cards.map((j) => [j.reference, j.repeat]));
})();

// ================= Site contact reminder =================
(function siteContact() {
  console.log("\n== WhatsApp the site contact (FRE-195)");
  const b = setup(); const c = b.ctx; // tomorrow is Fri 9 Oct
  const agent = (ref, extra, startIso) => b.addBooking(Object.assign({
    Reference: ref, Name: "Pat Agent", Phone: "07000 000009", Email: "pat@acme.example", "Business name": "Acme Lettings", Channel: "Agent/Landlord",
    Address: "9 Flat Lane, Midsomer Norton, BA3 2AA", "Site contact name": "Sam Tenant", "Site contact phone": "07000 000002", "Payment method": "Invoice, 14 days",
  }, extra), startIso);
  agent("EC-60001", {}, "2026-10-09T08:00:00Z");
  agent("EC-60002", { "Site contact name": "", "Site contact phone": "", Access: "Agent arranging (24h notice)" }, "2026-10-09T11:00:00Z");
  agent("EC-60003", { "Site contact phone": "07000 000009" }, "2026-10-09T13:00:00Z"); // same as the booker
  b.addBooking({ Reference: "EC-60004" }, "2026-10-09T15:00:00Z"); // homeowner
  agent("EC-60005", { "Cancelled at": b.date("2026-10-07T09:00:00Z") }, "2026-10-09T16:00:00Z");
  agent("EC-60006", { "Site contact name": "Jo Smith", "Site contact phone": "+44 7000 000003" }, "2026-10-09T07:00:00Z");

  const msg = c.siteContactMessage_(b.row("EC-60001"), b.date("2026-10-09T08:00:00Z"));
  check("the message", msg === "Hi Sam, it's Niall from EasyClean Somerset. Acme Lettings has booked us to clean at 9 Flat Lane, BA3 on Friday 9 October at 9:00am. Could you make sure we can get in? Let me know if there's anything we should know about parking or access. Thanks.", msg);

  const n = c.sendSiteContactDigest_();
  check("one email to you for tomorrow's two agent jobs with a site contact", n === 2, n);
  const mail = ownerMails(b).filter((m) => /message the site contacts/.test(m.subject))[0];
  check("it has a WhatsApp link per job, earliest first", mail && mail.body.indexOf("https://wa.me/447000000003?text=") !== -1 && mail.body.indexOf("https://wa.me/447000000002?text=") !== -1 &&
    mail.body.indexOf("EC-60006") < mail.body.indexOf("EC-60001"), mail && mail.body);
  check("with the message ready written", mail && mail.body.indexOf(encodeURIComponent("Hi Sam, it's Niall")) !== -1);
  check("no job without a site contact, the booker's own number, a homeowner, or a cancelled job",
    ["EC-60002", "EC-60003", "EC-60004", "EC-60005"].every((r) => mail.body.indexOf(r) === -1));
  check("only once a day", c.sendSiteContactDigest_() === 0 && ownerMails(b).filter((m) => /site contact/.test(m.subject)).length === 1);

  let job = c.adminGetJob(b.row("EC-60001")["Job token"]);
  check("the job page has the WhatsApp link", /^https:\/\/wa\.me\/447000000002\?text=/.test(job.siteContactWa), job.siteContactWa);
  check("not for a job with no site contact", c.adminGetJob(b.row("EC-60002")["Job token"]).siteContactWa === "");
  check("not for a homeowner", c.adminGetJob(b.row("EC-60004")["Job token"]).siteContactWa === "");
  c.adminCompleteJob(b.row("EC-60001")["Job token"], "", "keys left");
  check("and not once it's signed off", c.adminGetJob(b.row("EC-60001")["Job token"]).siteContactWa === "");

  const quiet = setup("2026-10-10T06:00:00Z"); // Sat: nothing on Sunday
  check("no agent jobs tomorrow: no email", quiet.ctx.sendSiteContactDigest_() === 0 && ownerMails(quiet).length === 0);
})();

// ================= Marketing opt-ins =================
(function marketing() {
  console.log("\n== Marketing consent and unsubscribes (FRE-203)");
  const b = setup(); const c = b.ctx;
  const yes = web(b, { marketingOptIn: true }, 5);
  let row = b.row(yes.reference);
  check("an opt-in records the words and the date", row["Marketing opt-in"] === "Yes" &&
    row["Marketing consent"] === "Ticked \"Keep me posted about seasonal offers and cleaning reminders\" when booking online, 8 October 2026", row["Marketing consent"]);
  const agentYes = web(b, { marketingOptIn: true, channel: "Agent/Landlord", businessName: "Acme", siteContactName: "Sam", siteContactPhone: "07000 000002", email: "pat@acme.example", phone: "07000 000009", payment: "Invoice, 14 days" }, 9);
  check("agents get their own box's words", agentYes.ok && /Keep me posted about availability and landlord\/agent offers/.test(b.row(agentYes.reference)["Marketing consent"]), agentYes);
  const sent = web(b, { marketingOptIn: true, email: "words@example.com", phone: "07000 000011", marketingConsentText: "  Send me   offers  " }, 14);
  check("words sent by the page are used if there are any", /Ticked "Send me offers"/.test(b.row(sent.reference)["Marketing consent"]));
  const no = web(b, { email: "no@example.com", phone: "07000 000012" }, 18);
  check("no tick, no consent", b.row(no.reference)["Marketing opt-in"] === "No" && b.row(no.reference)["Marketing consent"] === "");
  check("over-long consent text is refused", c.createBooking({ marketingConsentText: "x".repeat(301), startTime: c.getAvailableSlots()[22].start, name: "A", phone: "07000 000013", email: "a@example.com", address: "1 St", postcode: "BA3 2AA", lineItems: [{ item: "Medium room", qty: 1 }], channel: "Consumer", payment: "Cash" }).error === "bad_details");
  b.addBooking({ Reference: "EC-70001", Email: "old@example.com", "Marketing opt-in": "Yes", Timestamp: b.date("2026-09-01T09:00:00Z") }); // from before this version

  let job = c.adminGetJob(row["Job token"]);
  check("the job page shows they're opted in, with the words", job.marketing && job.marketing.optedIn === true && /seasonal offers/.test(job.marketing.consent), job.marketing);
  check("nothing shown for someone who didn't tick", c.adminGetJob(b.row(no.reference)["Job token"]).marketing.optedIn === false);

  check("the list has everyone who ticked", c.refreshMarketingList() === 4);
  const list = () => {
    const tab = c.SpreadsheetApp.openById(Object.keys(b.state.spreadsheets)[0]).getSheetByName("Marketing list");
    return tab.rows.slice(1).map((r) => r[0]);
  };
  check("by email, not the ones who didn't tick", list().indexOf("sam@example.com") !== -1 && list().indexOf("no@example.com") === -1 && list().indexOf("old@example.com") !== -1, list());
  const tab = c.SpreadsheetApp.openById(Object.keys(b.state.spreadsheets)[0]).getSheetByName("Marketing list");
  const oldRow = tab.rows.filter((r) => r[0] === "old@example.com")[0];
  check("an older opt-in says its wording wasn't recorded", /wording not recorded/.test(oldRow[4]), oldRow);

  // Sam replies STOP. They also booked again under the same email.
  const again = web(b, { email: "Sam@Example.com" }, 26);
  let r = c.adminSetUnsubscribed(row["Job token"], true);
  check("unsubscribing marks every booking with that email", r.ok && r.rows === 2 && b.row(yes.reference)["Unsubscribed on"] instanceof c.Date &&
    b.row(again.reference)["Unsubscribed on"] instanceof c.Date, r);
  check("no Dates in the reply", plainOk(b, r, "adminSetUnsubscribed"));
  job = c.adminGetJob(row["Job token"]);
  check("the job page shows the unsubscribe", job.marketing.optedIn === false && job.marketing.unsubscribedOn === "Thu 8 Oct 2026", job.marketing);
  c.refreshMarketingList();
  check("and they're off the list", list().indexOf("sam@example.com") === -1 && list().length === 3, list());
  r = c.adminSetUnsubscribed(row["Job token"], false);
  check("undo puts them back", r.ok && c.refreshMarketingList() === 4);
  c.adminSetUnsubscribed(row["Job token"], true);

  // A day later they tick the box again on a new booking: fresh consent.
  b.advanceMinutes(24 * 60);
  web(b, { email: "sam@example.com", marketingOptIn: true }, 30);
  c.refreshMarketingList();
  check("ticking again later puts them back on the list", list().indexOf("sam@example.com") !== -1);
  check("a booking with no email can't be unsubscribed", c.adminSetUnsubscribed(b.addBooking({ Reference: "EC-70002", Email: "" })["Job token"], true).ok === false);

  // The morning check compares the site's tick box with the words here.
  const page = (label) => ({ fetch: () => ({ getResponseCode: () => 200, getContentText: () => '<label class="bf-checkbox-row"><input type="checkbox" id="bf-marketing"> ' + label + '</label>' }) });
  c.UrlFetchApp = page("Keep me posted about seasonal offers and cleaning reminders");
  check("reads the tick box words from the page", c.liveConsentLabel_("index.html") === "Keep me posted about seasonal offers and cleaning reminders");
  c.UrlFetchApp = page("Send me offers &amp; news");
  const text = c.dailyHealthCheck_({ now: b.date(NOW), force: true }).issues.join(" | ");
  check("a changed tick box is reported", text.indexOf("The marketing tick box on index.html now says \"Send me offers & news\". Update MARKETING_CONSENT_TEXT in Code.gs") !== -1, text);
  c.UrlFetchApp = { fetch: () => { throw new Error("offline"); } };
  check("an unreadable page isn't reported twice", c.liveConsentLabel_("index.html") === null);
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
process.exit(failures ? 1 : 0);
