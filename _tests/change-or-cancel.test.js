/*
 * FRE-213: customers changing or cancelling their own booking online, from
 * the Change or cancel button in their emails (my-booking.html).
 *
 * From the repo root:
 *   node _tests/change-or-cancel.test.js
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

// Thu 8 Oct 2026, 10:00am UK time. Times are British Summer Time until 25 Oct.
const NOW = "2026-10-08T09:00:00Z";
const T1 = "a".repeat(32), T2 = "b".repeat(32), T3 = "c".repeat(32), T4 = "d".repeat(32);

function setup() {
  const b = loadBackend({ now: NOW });
  b.setUpSheet();
  return b;
}
// A homeowner booking for Mon 12 Oct, 9:00am, booked on 1 Oct (so the
// 14 days run to 15 Oct).
function homeBooking(b, extra, startIso) {
  return b.addBooking(Object.assign({
    Reference: "EC-10001", "Manage token": T1, Timestamp: b.date("2026-10-01T09:00:00Z"),
    Address: "1 High Street, Midsomer Norton, BA3 2AA", Items: "2× Medium room: £90, 1× Armchair: £15", Total: "£105",
  }, extra || {}), startIso || "2026-10-12T08:00:00Z");
}
const event = (b, ref) => b.state.events.filter((e) => /Reference: (EC-\d+)/.exec(e.description || "") && /Reference: (EC-\d+)/.exec(e.description)[1] === ref && !e.deleted);
const eventStart = (b, ref) => { const e = b.ctx.findBookingEvent_(ref); return e ? e.getStartTime().toISOString() : null; };
const lastTo = (b, to) => { const m = b.sentTo(to); return m[m.length - 1]; };
const ownerMails = (b) => b.state.emails.filter((e) => e.to === "owner@example.com");

// ================= Looking up a booking =================
(function lookUp() {
  console.log("\n== GET ?action=booking");
  const b = setup(); const c = b.ctx;
  const v = homeBooking(b);

  const r = c.getPublicBooking(T1);
  check("found by its manage token", r.ok === true && r.reference === "EC-10001", r);
  check("no Dates in the reply", (() => { try { b.checkPlain(r, "getPublicBooking"); return true; } catch (e) { return false; } })());
  check("channel homeowner", r.channel === "homeowner");
  check("date and time in UK time", r.date === "2026-10-12" && r.time === "09:00", [r.date, r.time]);
  check("whenLabel", r.whenLabel === "Mon 12 Oct at 9:00am", r.whenLabel);
  check("short address is first line and district", r.addressShort === "1 High Street, BA3", r.addressShort);
  check("items split into name and qty", JSON.stringify(r.items) === JSON.stringify([{ name: "Medium room", qty: 2 }, { name: "Armchair", qty: 1 }]), r.items);
  check("total as written", r.total === "£105", r.total);
  check("estMins from the calendar event when not recorded", r.estMins === 150, r.estMins);
  check("can change, two moves left", r.canChange === true && r.notChangeableReason === null && r.movesLeft === 2);
  check("cancel deadline is 14 days from booking", r.cancelDeadline === "2026-10-15", r.cancelDeadline);
  check("early start not given", r.earlyStartGiven === false);
  const json = JSON.stringify(r);
  check("nothing private in the reply", json.indexOf(v.Email) === -1 && json.indexOf("07000") === -1 && json.indexOf("2AA") === -1 && json.indexOf(v["Job token"]) === -1, json);

  check("unknown token: not_found", c.getPublicBooking("f".repeat(32)).error === "not_found");
  check("junk token: not_found", c.getPublicBooking("<x>").error === "not_found" && c.getPublicBooking(undefined).error === "not_found");
  check("the job token doesn't work here", c.getPublicBooking(v["Job token"]).error === "not_found");
  check("the manage token can't open the sign-off page", c.getPublicJob(T1).ok === false);
  check("the manage token can't sign off a job",
    c.completeJobPublic({ token: T1, signature: "data:image/png;base64,iVBORw0KGgo=" }).ok === false && !b.row("EC-10001")["Completed at"]);

  b.row("EC-10001");
  const out = c.doGet({ parameter: { action: "booking", t: T1 } });
  check("doGet routes action=booking", JSON.parse(out.text).reference === "EC-10001");
})();

// ================= Slots for moving =================
(function slots() {
  console.log("\n== GET ?action=rescheduleSlots");
  const b = setup(); const c = b.ctx;
  homeBooking(b);
  b.addBooking({ Reference: "EC-10002", "Manage token": T2 }, "2026-10-13T08:00:00Z"); // Tue 13 Oct 9:00 to 11:30
  const r = c.getRescheduleSlots(T1);
  check("ok", r.ok === true && Array.isArray(r.slots) && r.slots.length > 0, r);
  const has = (iso) => r.slots.some((s) => Date.parse(s.start) === Date.parse(iso));
  check("its own current time isn't offered", !has("2026-10-12T08:00:00Z"));
  check("its own slot doesn't count as busy (Mon 10am offered)", has("2026-10-12T09:00:00Z"));
  check("another booking's time is busy (Tue 9am, 10am, 11am)", !has("2026-10-13T08:00:00Z") && !has("2026-10-13T09:00:00Z") && !has("2026-10-13T10:00:00Z"));
  check("Tue 8am is busy too (would run into the 9am job)", !has("2026-10-13T07:00:00Z"));
  check("Tue 12pm is free", has("2026-10-13T11:00:00Z"));
  check("no Sundays", !r.slots.some((s) => s.dayLabel.indexOf("Sun") === 0));
  check("nothing inside 24 hours", r.slots.every((s) => new Date(s.start) >= new Date("2026-10-09T09:00:00Z")));
  check("nothing past 21 days", r.slots.every((s) => new Date(s.start) < new Date("2026-10-29T00:00:00Z")));
  check("same shape as the booking form's slots", Object.keys(r.slots[0]).join() === "start,dayLabel,timeLabel", Object.keys(r.slots[0]));
  check("lower-case am/pm", r.slots.every((s) => /^\d{1,2}:\d{2}(am|pm)$/.test(s.timeLabel)), r.slots[0].timeLabel);
  check("the website's own slots are unchanged (own booking still busy)", !c.getAvailableSlots().some((s) => Date.parse(s.start) === Date.parse("2026-10-12T08:00:00Z") || Date.parse(s.start) === Date.parse("2026-10-12T09:00:00Z")));
  check("doGet routes action=rescheduleSlots", JSON.parse(c.doGet({ parameter: { action: "rescheduleSlots", t: T1 } }).text).ok === true);

  // A longer job only gets times its whole length fits
  const b2 = setup();
  homeBooking(b2, {}, "2026-10-12T08:00:00Z");
  b2.state.events[0].end = new Date(Date.parse("2026-10-12T08:00:00Z") + 300 * 60000); // 5 hours
  b2.addBooking({ Reference: "EC-10002", "Manage token": T2 }, "2026-10-13T13:00:00Z"); // Tue 2pm
  const r2 = b2.ctx.getRescheduleSlots(T1);
  check("a 5-hour job can't start Tue 10am (runs into the 2pm job)", !r2.slots.some((s) => Date.parse(s.start) === Date.parse("2026-10-13T09:00:00Z")));
  check("but can start Tue 8am (done by 1pm)", r2.slots.some((s) => Date.parse(s.start) === Date.parse("2026-10-13T07:00:00Z")));
})();

// ================= Moving =================
(function move() {
  console.log("\n== POST reschedule");
  const b = setup(); const c = b.ctx;
  homeBooking(b, { "Early start request": "Yes, ticked at booking", "Day-before reminder sent": b.date("2026-10-07T07:00:00Z") });
  b.addBooking({ Reference: "EC-10002", "Manage token": T2 }, "2026-10-13T08:00:00Z");

  let r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-13", time: "09:00", earlyStart: true });
  check("into another booking's time: slot_taken", r.error === "slot_taken", r);
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-18", time: "10:00" });
  check("a Sunday: slot_taken", r.error === "slot_taken", r);
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-09", time: "08:00" });
  check("less than 24 hours away: slot_taken", r.error === "slot_taken", r);
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-11-02", time: "10:00" });
  check("more than 21 days away: slot_taken", r.error === "slot_taken", r);
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-14", time: "09:30" });
  check("a time we don't offer: slot_taken", r.error === "slot_taken", r);
  r = c.rescheduleBookingPublic({ t: T1, date: "14/10/2026", time: "9am" });
  check("junk date: slot_taken", r.error === "slot_taken", r);
  check("nothing moved yet", eventStart(b, "EC-10001") === "2026-10-12T08:00:00.000Z" && !b.row("EC-10001")["Online moves"]);
  check("no emails yet", b.state.emails.length === 0);

  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-12", time: "10:00" });
  check("same day, an hour later, overlapping its own slot: ok", r.ok === true && r.date === "2026-10-12" && r.time === "10:00" && r.whenLabel === "Mon 12 Oct at 10:00am", r);
  check("calendar event moved, same length", eventStart(b, "EC-10001") === "2026-10-12T09:00:00.000Z" &&
    c.findBookingEvent_("EC-10001").getEndTime().getTime() - c.findBookingEvent_("EC-10001").getStartTime().getTime() === 150 * 60000);
  let row = b.row("EC-10001");
  check("sheet: booking time updated", row["Booking time"] === "Mon 12 Oct, 10:00am", row["Booking time"]);
  check("sheet: Changes says who and what", /8 Oct: moved online by customer from Mon 12 Oct, 9:00am to Mon 12 Oct, 10:00am/.test(row.Changes), row.Changes);
  check("sheet: one online move", row["Online moves"] === 1, row["Online moves"]);
  check("same day: day-before reminder left alone", row["Day-before reminder sent"] instanceof b.ctx.Date);

  let mail = lastTo(b, "sam@example.com");
  check("customer emailed the new time", mail && mail.subject === "Booking moved: Mon 12 Oct, 10:00am (EC-10001)" &&
    mail.body.indexOf("from Mon 12 Oct, 9:00am to Mon 12 Oct, 10:00am") !== -1, mail && mail.subject);
  check("moved email has the Change or cancel button", mail.html.indexOf("my-booking.html?t=" + T1) !== -1 && mail.html.indexOf(">Change or cancel<") !== -1);
  check("moved email has the trader details", mail.body.indexOf("Business details:") !== -1);
  check("you got an alert", ownerMails(b).some((m) => /Moved online: EC-10001 to Mon 12 Oct, 10:00am/.test(m.subject) && m.body.indexOf("Online moves used: 1 of 2.") !== -1));

  // Same time again: nothing happens and no move is used
  const before = b.state.emails.length;
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-12", time: "10:00" });
  check("moving to the time it already has: ok, no move used, no emails", r.ok && b.row("EC-10001")["Online moves"] === 1 && b.state.emails.length === before);

  // Another day: reminders reset
  r = c.doPost({ postData: { contents: JSON.stringify({ action: "reschedule", t: T1, date: "2026-10-20", time: "14:00" }) } });
  r = JSON.parse(r.text);
  check("doPost routes reschedule, to another day: ok", r.ok === true && r.whenLabel === "Tue 20 Oct at 2:00pm", r);
  row = b.row("EC-10001");
  check("two moves used", row["Online moves"] === 2);
  check("another day: day-before reminder cleared so it goes again", row["Day-before reminder sent"] === "", row["Day-before reminder sent"]);
  check("both moves in Changes", (row.Changes.match(/moved online/g) || []).length === 2, row.Changes);

  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-21", time: "14:00" });
  check("a third move: no_moves_left", r.error === "no_moves_left", r);
  check("rescheduleSlots says no_moves_left too", c.getRescheduleSlots(T1).error === "no_moves_left");
  check("booking shows no moves left", c.getPublicBooking(T1).movesLeft === 0);
  check("but can still cancel", c.cancelBookingPublic({ t: T1 }).ok === true);
})();

// ================= The 14-day early-start box =================
(function earlyStart() {
  console.log("\n== Early-start box when moving");
  const b = setup(); const c = b.ctx;
  homeBooking(b, { "Early start request": "Not needed (clean is after the 14 days)" }, "2026-10-20T08:00:00Z");

  let r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-14", time: "10:00" });
  check("into the 14 days without the box: needs_early_start", r.error === "needs_early_start", r);
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-15", time: "10:00", earlyStart: "yes" });
  check("only a real true counts", r.error === "needs_early_start", r);
  check("nothing moved", eventStart(b, "EC-10001") === "2026-10-20T08:00:00.000Z");
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-16", time: "10:00" });
  check("the day after the deadline needs no box", r.ok === true, r);
  r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-15", time: "10:00", earlyStart: true });
  check("on the deadline with the box ticked: ok", r.ok === true, r);
  check("the sheet records it", b.row("EC-10001")["Early start request"] === "Yes, ticked when moving online", b.row("EC-10001")["Early start request"]);
  check("and the page now knows", c.getPublicBooking(T1).earlyStartGiven === true);
  check("your alert mentions it", ownerMails(b).some((m) => m.body.indexOf("ticked the box") !== -1));
})();

// ================= Cancelling =================
(function cancel() {
  console.log("\n== POST cancel");
  const b = setup(); const c = b.ctx;
  homeBooking(b);
  let r = c.doPost({ postData: { contents: JSON.stringify({ action: "cancel", t: T1, reason: "Plans changed" }) } });
  r = JSON.parse(r.text);
  check("doPost routes cancel: ok", r.ok === true, r);
  const row = b.row("EC-10001");
  check("Cancelled at set", row["Cancelled at"] instanceof b.ctx.Date);
  check("Cancelled by: customer online, with the reason", row["Cancelled by"] === "Customer (online: Plans changed)", row["Cancelled by"]);
  check("no fee", !row["Cancellation fee"] && !row["Invoice number"]);
  check("Income is 0", row.Income === 0, row.Income);
  check("calendar event removed", c.findBookingEvent_("EC-10001") === null);
  const mail = lastTo(b, "sam@example.com");
  check("customer gets a written acknowledgement", mail && mail.subject === "Booking cancelled: EC-10001" &&
    mail.body.indexOf("We've received your cancellation, made online on Thu 8 Oct, 10:00am.") !== -1 &&
    mail.body.indexOf("is cancelled, and there's nothing to pay.") !== -1, mail && mail.body);
  check("no attachment, no fee wording", mail.attachments.length === 0 && !/fee/i.test(mail.body.split("--")[0]));
  check("you got an alert", ownerMails(b).some((m) => m.subject === "[EasyClean] Cancelled online: EC-10001, Mon 12 Oct, 9:00am" && m.body.indexOf("Reason given: Plans changed") !== -1));
  check("the slot is free on the website again", c.getAvailableSlots().some((s) => Date.parse(s.start) === Date.parse("2026-10-12T08:00:00Z")));

  check("cancel again: cancelled", c.cancelBookingPublic({ t: T1 }).error === "cancelled");
  check("move after cancelling: cancelled", c.rescheduleBookingPublic({ t: T1, date: "2026-10-14", time: "10:00" }).error === "cancelled");
  const p = c.getPublicBooking(T1);
  check("page shows it can't change: cancelled", p.ok && p.canChange === false && p.notChangeableReason === "cancelled");
  check("rescheduleSlots: cancelled", c.getRescheduleSlots(T1).error === "cancelled");

  // A reason we don't offer is dropped
  const b2 = setup();
  homeBooking(b2);
  b2.ctx.cancelBookingPublic({ t: T1, reason: "<b>rude</b>" });
  check("an unknown reason is left out", b2.row("EC-10001")["Cancelled by"] === "Customer (online)", b2.row("EC-10001")["Cancelled by"]);
})();

(function lateCancel() {
  console.log("\n== Cancelling with less than 24 hours' notice");
  const b = setup(); const c = b.ctx;
  homeBooking(b, {}, "2026-10-09T07:00:00Z"); // tomorrow 8am
  const r = c.cancelBookingPublic({ t: T1 });
  check("allowed", r.ok === true, r);
  const row = b.row("EC-10001");
  check("still no fee", !row["Cancellation fee"] && !row["Invoice number"], row["Cancellation fee"]);
  check("noted as short notice for you", /less than 24 hours/.test(row["Cancelled by"]), row["Cancelled by"]);
  const mail = lastTo(b, "sam@example.com");
  check("customer email has no fee", !/£25|fee/i.test(mail.body.split("--")[0]));
  check("your alert says no fee", ownerMails(b).some((m) => m.body.indexOf("Online cancellations never carry a fee.") !== -1));
})();

(function tooLate() {
  console.log("\n== Started, signed off, or no calendar event");
  const b = setup(); const c = b.ctx;
  homeBooking(b, {}, "2026-10-08T07:00:00Z"); // 8am today, it's now 10am
  check("after the start time: started", c.getPublicBooking(T1).notChangeableReason === "started" && c.getPublicBooking(T1).canChange === false);
  check("cancel: started", c.cancelBookingPublic({ t: T1 }).error === "started");
  check("move: started", c.rescheduleBookingPublic({ t: T1, date: "2026-10-14", time: "10:00" }).error === "started");
  check("still in the calendar", c.findBookingEvent_("EC-10001") !== null);

  b.addBooking({ Reference: "EC-10002", "Manage token": T2, "Started at": b.date("2026-10-08T08:50:00Z") }, "2026-10-08T10:00:00Z");
  check("timer started early: started", c.cancelBookingPublic({ t: T2 }).error === "started");
  b.addBooking({ Reference: "EC-10003", "Manage token": T3, "Completed at": b.date("2026-10-07T12:00:00Z") }, "2026-10-12T12:00:00Z");
  check("signed off: completed", c.cancelBookingPublic({ t: T3 }).error === "completed" && c.getPublicBooking(T3).notChangeableReason === "completed");
  b.addBooking({ Reference: "EC-10004", "Manage token": T4 }); // no calendar event
  const p = c.getPublicBooking(T4);
  check("no calendar event: shown, but can't be changed online", p.ok && p.canChange === false && p.notChangeableReason === null && p.whenLabel === "Wed 7 Oct, 9:00am", p);
  check("no calendar event: move refused", c.rescheduleBookingPublic({ t: T4, date: "2026-10-14", time: "10:00" }).error === "not_found");
})();

// ================= Agents =================
(function agents() {
  console.log("\n== Agent bookings");
  const b = setup(); const c = b.ctx;
  b.addBooking({
    Reference: "EC-20001", "Manage token": T1, Name: "Pat Agent", Email: "pat@acme.example", Channel: "Agent/Landlord",
    "Business name": "Acme Lettings", Timestamp: b.date("2026-10-07T09:00:00Z"), Address: "5 Mill Lane, Radstock, BA3 4BB",
  }, "2026-10-20T08:00:00Z");
  const p = c.getPublicBooking(T1);
  check("channel agent, no deadline, no early-start", p.channel === "agent" && p.cancelDeadline === null && p.earlyStartGiven === false, p);
  const r = c.rescheduleBookingPublic({ t: T1, date: "2026-10-14", time: "10:00" });
  check("moving soon needs no early-start box", r.ok === true, r);
  check("moved email goes to the agent", lastTo(b, "pat@acme.example").subject.indexOf("Booking moved") === 0);
  check("cancel ok", c.cancelBookingPublic({ t: T1, reason: "Other" }).ok === true);
  check("cancel email goes to the agent", lastTo(b, "pat@acme.example").subject === "Booking cancelled: EC-20001");
  check("your alert names the agency", ownerMails(b).some((m) => m.body.indexOf("Pat Agent (Acme Lettings) cancelled") === 0));
})();

// ================= Emails: the button =================
(function emails() {
  console.log("\n== Change or cancel button in emails");
  const b = setup(); const c = b.ctx;
  const data = {
    name: "Sam Customer", email: "sam@example.com", phone: "07000 000001", address: "1 High Street", postcode: "BA3 2AA",
    items: "2× Medium room: £90", total: "£90", payment: "Cash", channel: "Consumer", notes: "", manageToken: T1,
  };
  data.cancellation = c.cancellationInfo_(data, b.date("2026-10-14T09:00:00Z"), b.date(NOW));
  c.sendBookingConfirmation_(data, "EC-10042", "Wed 14 Oct, 10:00am");
  let mail = lastTo(b, "sam@example.com");
  const link = "https://easycleansomerset.co.uk/my-booking.html?t=" + T1;
  check("confirmation: button links to my-booking.html", mail.html.indexOf('href="' + link + '"') !== -1 && mail.html.indexOf(">Change or cancel<") !== -1);
  check("confirmation: WhatsApp still there", mail.html.indexOf(">WhatsApp us<") !== -1);
  check("confirmation: right to cancel mentions the button", mail.html.indexOf("Use the Change or cancel button above, reply to this email, WhatsApp us, or use the cancellation form attached.") !== -1);
  check("confirmation: PDF still attached", mail.attachments.length === 1);
  check("confirmation text: link", mail.body.indexOf("Need to change or cancel? Do it online: " + link) !== -1 && mail.body.indexOf("Use the Change or cancel button above") !== -1);

  b.setUpSheet();
  const v = homeBooking(b);
  c.sendDayBeforeEmail(b.row("EC-10001"), b.date("2026-10-12T08:00:00Z"));
  mail = lastTo(b, "sam@example.com");
  check("day-before reminder: button", mail.html.indexOf('href="' + link + '"') !== -1 && mail.body.indexOf("Do it online: " + link) !== -1);
  c.sendReminderEmail(b.row("EC-10001"), b.date("2026-10-12T08:00:00Z"));
  mail = lastTo(b, "sam@example.com");
  check("morning reminder: button", mail.html.indexOf('href="' + link + '"') !== -1 && mail.body.indexOf("Do it online: " + link) !== -1);

  b.addBooking({ Reference: "EC-10009", Email: "old@example.com" }, "2026-10-12T12:00:00Z"); // older booking, no manage token
  c.sendDayBeforeEmail(b.row("EC-10009"), b.date("2026-10-12T12:00:00Z"));
  mail = lastTo(b, "old@example.com");
  check("a booking without a token keeps the old wording", mail.html.indexOf("my-booking.html") === -1 && mail.body.indexOf("Need to change anything? Reply to this email or WhatsApp us:") !== -1);
  check("token is escaped safely in the link", c.manageLink_("<script>") === "" && c.manageLink_(T1) === link);
})();

// ================= New bookings get a token =================
(function newBookings() {
  console.log("\n== Admin-app bookings and the backfill");
  const b = setup(); const c = b.ctx;
  const r = c.adminCreateBooking({
    name: "New Person", email: "new@example.com", phone: "07000 000009", address: "9 Station Road", postcode: "BA3 3AA",
    payment: "Cash", lines: [{ desc: "Medium room", qty: 1, unit: 45, mins: 40 }], date: "2026-10-14", time: "10:00", lengthMins: 120, emailCustomer: true,
  });
  check("admin booking made", r.ok === true, r);
  const row = b.row(r.reference);
  check("it has a manage token, different from its job token", /^[0-9a-f]{32}$/.test(row["Manage token"]) && row["Manage token"] !== row["Job token"], row["Manage token"]);
  const mail = lastTo(b, "new@example.com");
  check("its confirmation has the button", mail.html.indexOf("my-booking.html?t=" + row["Manage token"]) !== -1);
  check("and the page can load it", c.getPublicBooking(row["Manage token"]).reference === r.reference);

  b.addBooking({ Reference: "EC-30001" }, "2026-10-15T08:00:00Z");
  b.addBooking({ Reference: "EC-30002", "Cancelled at": b.date("2026-10-02T09:00:00Z") });
  b.addBooking({ Reference: "EC-30003", "Completed at": b.date("2026-10-02T09:00:00Z") });
  b.addBooking({ Reference: "EC-30004", "Manage token": T4 }, "2026-10-16T08:00:00Z");
  const added = c.setUpManageTokens();
  check("backfill adds one to the open booking without one", added === 1 && /^[0-9a-f]{32}$/.test(b.row("EC-30001")["Manage token"]), added);
  check("and leaves cancelled, signed-off and existing ones alone",
    !b.row("EC-30002")["Manage token"] && !b.row("EC-30003")["Manage token"] && b.row("EC-30004")["Manage token"] === T4);
  check("running it again adds none", c.setUpManageTokens() === 0);
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
process.exit(failures ? 1 : 0);
