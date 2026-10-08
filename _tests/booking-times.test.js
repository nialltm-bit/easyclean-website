/*
 * FRE-203 and FRE-6: booking times kept in the sheet, and one-time booking IDs.
 *
 * - Jobs not signed off stay in "Waiting for sign-off" however long ago they
 *   were (they used to drop out after 30 days and were never invoiced).
 * - A booking whose calendar event was deleted by hand stays in the lists,
 *   is flagged "Not in calendar", and can be put back with one tap.
 * - The morning check lists both.
 * - A booking sent twice with the same requestId (the page retrying after a
 *   dropped connection) is only booked once.
 *
 * From the repo root:
 *   node _tests/booking-times.test.js
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
const DAY = 86400000;

function setup() {
  const b = loadBackend({ now: NOW });
  b.setUpSheet();
  return b;
}
const refOf = (e) => (/Reference: (EC-\d+)/.exec(e.description || "") || [])[1];
const eventsFor = (b, ref) => b.state.events.filter((e) => refOf(e) === ref);
const deleteEventsFor = (b, ref) => eventsFor(b, ref).forEach((e) => e.deleteEvent());
const ownerMails = (b) => b.state.emails.filter((e) => e.to === "owner@example.com");
const refs = (list) => list.map((j) => j.reference);
const plainOk = (b, x, where) => { try { b.checkPlain(x, where); return true; } catch (e) { return false; } };
const health = (b) => b.ctx.dailyHealthCheck_({ now: b.date(NOW), force: true }).issues.join(" | ");

// ================= Unsigned jobs stay listed =================
(function unsigned() {
  console.log("\n== Jobs waiting for sign-off don't drop off the list");
  const b = setup(); const c = b.ctx;
  b.addBooking({ Reference: "EC-10001" }, "2026-08-29T09:00:00Z"); // 40 days ago, still in the calendar
  b.addBooking({ Reference: "EC-10002", "Starts at": b.date("2026-03-20T09:00:00Z"), "Ends at": b.date("2026-03-20T11:30:00Z") }, "2026-03-20T09:00:00Z"); // 202 days ago
  b.addBooking({ Reference: "EC-10003" }, "2026-10-07T08:00:00Z"); // yesterday
  b.addBooking({ Reference: "EC-10004", "Completed at": b.date("2026-09-01T12:00:00Z") }, "2026-09-01T09:00:00Z");
  b.addBooking({ Reference: "EC-10005", "Cancelled at": b.date("2026-09-01T12:00:00Z") });
  b.addBooking({ Reference: "EC-10006" }, "2026-10-18T09:00:00Z"); // in 10 days
  b.addBooking({ Reference: "EC-10007" }, "2026-11-22T10:00:00Z"); // in 45 days
  b.addBooking({ Reference: "EC-10008" }, "2026-10-08T13:00:00Z"); // today

  const o = c.adminGetOverview();
  check("the overview has no Dates in it", plainOk(b, o, "adminGetOverview"));
  check("a job 40 days ago is still waiting for sign-off", refs(o.waiting).indexOf("EC-10001") !== -1, refs(o.waiting));
  check("so is one 202 days ago", refs(o.waiting).indexOf("EC-10002") !== -1);
  check("and yesterday's", refs(o.waiting).indexOf("EC-10003") !== -1);
  check("oldest first", refs(o.waiting).join(",") === "EC-10002,EC-10001,EC-10003", refs(o.waiting));
  check("signed-off and cancelled jobs aren't waiting", refs(o.waiting).indexOf("EC-10004") === -1 && refs(o.waiting).indexOf("EC-10005") === -1);
  check("today's job is under Today", refs(o.today).join(",") === "EC-10008", refs(o.today));
  check("Coming up still shows the next 30 days only", refs(o.upcoming).join(",") === "EC-10006", refs(o.upcoming));
  check("none of these is flagged as missing from the calendar", o.waiting.concat(o.today, o.upcoming).every((j) => !j.calendarMissing));
  check("the waiting job shows its date", /29 Aug/.test(o.waiting[1].when), o.waiting[1].when);

  const saved = b.row("EC-10001")["Starts at"];
  check("an older booking gets its time copied into the sheet", saved instanceof c.Date && saved.toISOString() === "2026-08-29T09:00:00.000Z", saved);
  check("with its end time", b.row("EC-10001")["Ends at"] instanceof c.Date && b.row("EC-10001")["Ends at"].toISOString() === "2026-08-29T11:30:00.000Z");
  check("finished jobs' rows are left alone", b.row("EC-10004")["Starts at"] === "");

  const text = health(b);
  check("the morning check lists jobs done over 3 days ago and not signed off", /2 jobs done more than 3 days ago aren't signed off yet, so they haven't been invoiced: /.test(text) &&
    text.indexOf("EC-10001 (Sat 29 Aug, 10:00am)") !== -1 && text.indexOf("EC-10002") !== -1, text);
  check("but not yesterday's", text.indexOf("EC-10003") === -1);
  check("and nothing is reported missing from the calendar", text.indexOf("in your calendar any more") === -1);
})();

// ================= Calendar event deleted by hand =================
(function deletedEvent() {
  console.log("\n== A calendar event deleted by hand");
  const b = setup(); const c = b.ctx;
  const v = b.addBooking({ Reference: "EC-20001", "Manage token": "a".repeat(32) }, "2026-10-12T08:00:00Z", 150); // Mon 12 Oct, 9am
  c.adminGetOverview(); // copies the time into the sheet, as the app does on first open
  deleteEventsFor(b, "EC-20001");

  let o = c.adminGetOverview();
  const card = o.upcoming.filter((j) => j.reference === "EC-20001")[0];
  check("the booking is still listed", !!card, refs(o.upcoming));
  check("flagged Not in calendar", card && card.calendarMissing === true);
  check("with its time", card && /12 Oct/.test(card.when), card && card.when);

  let job = c.adminGetJob(v["Job token"]);
  check("the job page knows the event is missing", job.ok && job.hasCalendarEvent === false && job.hasSavedTime === true, job);
  check("and still shows the time", /12 Oct/.test(job.when), job.when);
  check("no Dates in the job page data", plainOk(b, job, "adminGetJob"));

  check("the morning check reports it", /1 booking isn't in your calendar any more: EC-20001 \(Mon 12 Oct, 9:00am\)/.test(health(b)), health(b));

  let r = c.adminRestoreEvent(v["Job token"], false);
  check("Put it back works", r.ok === true && /12 Oct/.test(r.when), r);
  check("no Dates in that reply", plainOk(b, r, "adminRestoreEvent"));
  let evs = eventsFor(b, "EC-20001");
  check("one event, back at the same time and length", evs.length === 1 && evs[0].start.toISOString() === "2026-10-12T08:00:00.000Z" &&
    evs[0].end.toISOString() === "2026-10-12T10:30:00.000Z", evs.map((e) => [e.start, e.end]));
  check("with the usual title and description", evs[0].title === "Clean: Sam Customer (£90)" &&
    evs[0].description.indexOf("Reference: EC-20001\n") === 0 && evs[0].description.indexOf("Job link") !== -1 && evs[0].description.indexOf("Phone: 07000 000001") !== -1, evs[0]);
  check("the address goes in the event's location", evs[0].location === "1 High Street, BA1 1AA", evs[0].location);
  o = c.adminGetOverview();
  check("it's no longer flagged", o.upcoming.filter((j) => j.reference === "EC-20001")[0].calendarMissing !== true);
  check("its time is taken on the website again", !c.getAvailableSlots().some((x) => x.start === "2026-10-12T08:00:00.000Z"));
  check("tapping it again doesn't add a second event", c.adminRestoreEvent(v["Job token"], false).already === true && eventsFor(b, "EC-20001").length === 1);

  // Something else got booked into the gap while it was missing.
  deleteEventsFor(b, "EC-20001");
  b.ctx.CalendarApp.getDefaultCalendar().createEvent("Dentist", b.date("2026-10-12T09:00:00Z"), b.date("2026-10-12T10:00:00Z"), {});
  r = c.adminRestoreEvent(v["Job token"], false);
  check("a clash asks first", r.ok === false && r.needsConfirm === true && r.clashes.join() === "Dentist", r);
  check("and nothing is added yet", eventsFor(b, "EC-20001").length === 0);
  r = c.adminRestoreEvent(v["Job token"], true);
  check("Put it back anyway adds it", r.ok === true && eventsFor(b, "EC-20001").length === 1);

  // Edge cases
  const old = b.addBooking({ Reference: "EC-20002" }); // older booking: no event and no saved time
  r = c.adminRestoreEvent(old["Job token"], false);
  check("no saved time: says to use Edit job", r.ok === false && /Use Edit job/.test(r.error), r);
  o = c.adminGetOverview();
  check("it still shows under Waiting for sign-off, flagged", o.waiting.some((j) => j.reference === "EC-20002" && j.calendarMissing));
  const done = b.addBooking({ Reference: "EC-20003", "Completed at": b.date("2026-10-01T12:00:00Z"), "Starts at": b.date("2026-10-01T09:00:00Z") });
  check("a signed-off job can't be put back", /signed off/.test(c.adminRestoreEvent(done["Job token"], false).error));
  const gone = b.addBooking({ Reference: "EC-20004", "Cancelled at": b.date("2026-10-01T12:00:00Z"), "Starts at": b.date("2026-10-14T09:00:00Z") });
  check("nor a cancelled one", /cancelled/.test(c.adminRestoreEvent(gone["Job token"], false).error));
  check("cancelled and signed-off rows aren't flagged", !o.waiting.concat(o.today, o.upcoming).some((j) => j.reference === "EC-20003" || j.reference === "EC-20004"));
})();

// ================= Cancelling and moving after the event has gone =================
(function cancelAndMove() {
  console.log("\n== Cancelling or moving a booking whose event was deleted");
  const b = setup(); const c = b.ctx;
  // Tomorrow 9am: a late cancellation (under 24 hours away).
  const v = b.addBooking({ Reference: "EC-30001", "Starts at": b.date("2026-10-09T08:00:00Z"), "Ends at": b.date("2026-10-09T10:30:00Z") });
  const r = c.adminCancelJob(v["Job token"], { reason: "customer", chargeFee: true, emailCustomer: false });
  check("cancelling still works", r.ok === true, r);
  check("and is recorded", b.row("EC-30001")["Cancelled at"] instanceof c.Date && /Customer/.test(b.row("EC-30001")["Cancelled by"]), b.row("EC-30001")["Cancelled by"]);
  check("the saved time still makes it a late cancellation, so the fee applies", b.row("EC-30001")["Cancellation fee"] === 25, b.row("EC-30001")["Cancellation fee"]);

  // The customer moves a booking whose event was deleted.
  const t = "b".repeat(32);
  b.addBooking({ Reference: "EC-30002", "Manage token": t, Timestamp: b.date("2026-09-20T09:00:00Z") }, "2026-10-13T08:00:00Z");
  c.adminGetOverview();
  deleteEventsFor(b, "EC-30002");
  const page = c.getPublicBooking(t);
  check("their page still shows the time and lets them change it", page.ok && page.date === "2026-10-13" && page.time === "09:00" && page.canChange === true, page);
  const m = c.rescheduleBookingPublic({ t: t, date: "2026-10-14", time: "10:00" });
  check("moving it works", m.ok === true, m);
  const evs = eventsFor(b, "EC-30002");
  check("and puts it back in the calendar at the new time", evs.length === 1 && evs[0].start.toISOString() === "2026-10-14T09:00:00.000Z", evs.map((e) => e.start));
  check("the sheet has the new time", b.row("EC-30002")["Starts at"].toISOString() === "2026-10-14T09:00:00.000Z");
})();

// ================= Times saved at booking, and moves =================
(function savedTimes() {
  console.log("\n== Times saved in the sheet");
  const b = setup(); const c = b.ctx;
  const slot = c.getAvailableSlots()[5];
  const r = c.createBooking(websiteData(slot.start, "wwwwwwwwwwwwwwwwwwwwwwww"));
  check("website booking made", r.ok === true, r);
  const row = b.row(r.reference);
  check("its start is saved", row["Starts at"] instanceof c.Date && row["Starts at"].toISOString() === slot.start, row["Starts at"]);
  check("and its end (one slot)", row["Ends at"].getTime() - row["Starts at"].getTime() === c.SLOT_MINS * 60000);
  check("and its request ID", row["Request ID"] === "wwwwwwwwwwwwwwwwwwwwwwww");

  const a = c.adminCreateBooking({
    name: "New Person", email: "new@example.com", phone: "07000 000009", address: "9 Station Road", postcode: "BA3 3AA",
    payment: "Cash", lines: [{ desc: "Medium room", qty: 1, unit: 45, mins: 40 }], date: "2026-10-14", time: "10:00", lengthMins: 120, emailCustomer: false,
  });
  check("admin booking made", a.ok === true, a);
  const ar = b.row(a.reference);
  check("admin booking times saved", ar["Starts at"].toISOString() === "2026-10-14T09:00:00.000Z" && ar["Ends at"].toISOString() === "2026-10-14T11:00:00.000Z", [ar["Starts at"], ar["Ends at"]]);

  const form = c.adminGetJobForEdit(a.token);
  form.lines = form.lines.map((l) => ({ desc: l.desc, qty: l.qty, unit: l.unit, mins: l.mins }));
  form.date = "2026-10-15"; form.time = "11:00"; form.emailCustomer = false;
  const u = c.adminUpdateJob(a.token, form);
  check("moving it in the admin app", u.ok === true, u);
  check("updates the saved time", b.row(a.reference)["Starts at"].toISOString() === "2026-10-15T10:00:00.000Z", b.row(a.reference)["Starts at"]);

  // Dragged to a new time in Google Calendar: the app picks it up.
  const ev = eventsFor(b, a.reference)[0];
  ev.setTime(b.date("2026-10-16T13:00:00Z"), b.date("2026-10-16T15:00:00Z"));
  c.adminGetOverview();
  check("a time moved in the calendar is copied into the sheet", b.row(a.reference)["Starts at"].toISOString() === "2026-10-16T13:00:00.000Z");

  // The edit form opens with the saved time when the event is gone.
  deleteEventsFor(b, a.reference);
  const f2 = c.adminGetJobForEdit(a.token);
  check("the edit form still has the date and time", f2.date === "2026-10-16" && f2.time === "14:00" && f2.lengthMins === 120 && f2.hasCalendarEvent === false, [f2.date, f2.time, f2.lengthMins]);
  f2.lines = f2.lines.map((l) => ({ desc: l.desc, qty: l.qty, unit: l.unit, mins: l.mins }));
  f2.emailCustomer = false;
  check("and saving it puts it back in the calendar", c.adminUpdateJob(a.token, f2).ok === true && eventsFor(b, a.reference).length === 1);
})();

// ================= One-time booking IDs =================
function websiteData(startIso, requestId) {
  return {
    startTime: startIso, name: "Sam Customer", phone: "07000 000001", email: "sam@example.com", address: "1 High Street",
    postcode: "BA3 2AA", items: "2× Medium room: £90", total: "£90", estTime: "~1h 55m", payment: "Cash", channel: "Consumer",
    slotLabel: "Fri 9 Oct at 3:00pm", lineItems: [{ item: "Medium room", qty: 2 }], requestId: requestId,
  };
}

(function requestIds() {
  console.log("\n== The same booking sent twice");
  const b = setup(); const c = b.ctx;
  const slots = c.getAvailableSlots();
  const id = "Req_" + "x".repeat(28);
  const first = c.createBooking(websiteData(slots[5].start, id));
  check("first send books it", first.ok === true && /^EC-\d{5}$/.test(first.reference), first);
  const again = c.createBooking(websiteData(slots[5].start, id));
  check("second send gets the same booking back", again.ok === true && again.reference === first.reference && again.repeat === true, again);
  check("only one calendar event", eventsFor(b, first.reference).length === 1 && b.state.events.length === 1, b.state.events.length);
  check("only one row in the sheet", b.sheet().rows.length === 2, b.sheet().rows.length);
  check("only one confirmation email", b.sentTo("sam@example.com").length === 1, b.sentTo("sam@example.com").length);
  check("only one new-booking email to you", ownerMails(b).filter((m) => /New booking/.test(m.subject)).length === 1);

  b.state.cache = {}; // the cache has expired: the sheet still knows
  const later = c.createBooking(websiteData(slots[5].start, id));
  check("still the same booking once the cache has gone", later.ok === true && later.reference === first.reference, later);
  check("still one event", b.state.events.length === 1);

  const other = c.createBooking(websiteData(slots[20].start, "Req_" + "y".repeat(28)));
  check("a different ID is a new booking", other.ok === true && other.reference !== first.reference && b.state.events.length === 2, other);
  check("the same ID for a time that's now taken still answers with the original", c.createBooking(websiteData(slots[20].start, id)).reference === first.reference);

  const noId = c.createBooking(websiteData(slots[30].start, undefined));
  check("a booking with no ID still works", noId.ok === true && b.row(noId.reference)["Request ID"] === "", noId);
  const odd = c.createBooking(websiteData(slots[40].start, "short"));
  check("an ID that isn't the right shape is ignored, not trusted", odd.ok === true && b.row(odd.reference)["Request ID"] === "", odd);
  check("IDs are checked for shape", c.cleanRequestId_("abc") === "" && c.cleanRequestId_("a".repeat(65)) === "" && c.cleanRequestId_("<script>alert(1)</script>xx") === "" &&
    c.cleanRequestId_(" " + "a".repeat(20) + " ") === "a".repeat(20) && c.cleanRequestId_(12345678901234567) === "");
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
process.exit(failures ? 1 : 0);
