/*
 * FRE-223: "I can't work today". One button in the admin app emails every
 * customer booked that day, asks them to pick a new time, keeps their jobs
 * open, and blocks the day.
 *
 * From the repo root:
 *   node _tests/day-off.test.js
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

// Thu 8 Oct 2026, 7:30am UK time (British Summer Time).
const NOW = "2026-10-08T06:30:00Z";
const T1 = "a".repeat(32), T7 = "7".repeat(32);
const NEW_TIME = "Needs a new time";

function setup(now) {
  const b = loadBackend({ now: now || NOW });
  b.setUpSheet();
  return b;
}
const ownerMails = (b) => b.state.emails.filter((e) => e.to === "owner@example.com");
const lastTo = (b, to) => { const m = b.sentTo(to); return m[m.length - 1]; };
const plainOk = (b, x, where) => { try { b.checkPlain(x, where); return true; } catch (e) { return false; } };
const blocks = (b) => b.state.events.filter((e) => e.allDay && /Added from the EasyClean admin app/.test(e.description));

// Today: three jobs to move, one with no email, one whose event was
// deleted by hand, and some that must be left alone.
function seed(b, first) {
  b.addBooking(Object.assign({ Reference: "EC-10001", "Manage token": T1, Email: "home@example.com", Name: "Sam Home", "Starts at": b.date("2026-10-08T08:00:00Z") }, first || {}), "2026-10-08T08:00:00Z");
  b.addBooking({ Reference: "EC-10002", Channel: "Agent/Landlord", "Business name": "Acme Lettings", Name: "Alex Agent", Email: "agent@example.com",
    Address: "4 Mill Lane, Frome, BA11 1AA", "Site contact name": "Terry Tenant", "Site contact phone": "07000 000222" }, "2026-10-08T12:00:00Z");
  b.addBooking({ Reference: "EC-10003", Email: "", Name: "Pat Phone", Phone: "07000 000333" }, "2026-10-08T14:00:00Z");
  b.addBooking({ Reference: "EC-10004", Email: "started@example.com", "Started at": b.date("2026-10-08T06:00:00Z") }, "2026-10-08T06:00:00Z");
  b.addBooking({ Reference: "EC-10005", Email: "cancelled@example.com", "Cancelled at": b.date("2026-10-05T09:00:00Z") }, "2026-10-08T15:30:00Z");
  b.addBooking({ Reference: "EC-10006", Email: "tomorrow@example.com", "Manage token": "6".repeat(32) }, "2026-10-09T08:00:00Z");
  // Event deleted by hand, time saved in the sheet.
  b.addBooking({ Reference: "EC-10007", Email: "noevent@example.com", "Manage token": T7, "Starts at": b.date("2026-10-08T10:30:00Z"), "Ends at": b.date("2026-10-08T12:00:00Z") });
}

// ================= Preview =================
(function preview() {
  console.log("\n== What the button would do");
  const b = setup(); const c = b.ctx; seed(b);
  const r = c.adminDayOffPreview("2026-10-08");
  check("no Dates in the reply", plainOk(b, r, "adminDayOffPreview"));
  check("names the day", r.ok === true && r.dayLabel === "Thursday 8 October", r.dayLabel);
  check("lists the four open jobs that day, in time order", r.jobs.map((j) => j.reference).join() === "EC-10001,EC-10007,EC-10002,EC-10003", r.jobs.map((j) => j.reference));
  check("leaves out a started job, a cancelled one and tomorrow's", !r.jobs.some((j) => /EC-1000[456]/.test(j.reference)));
  check("shows the agency's name for an agent job", r.jobs.filter((j) => j.reference === "EC-10002")[0].name === "Acme Lettings");
  check("flags the one with no email", r.jobs.filter((j) => j.reference === "EC-10003")[0].hasEmail === false);
  check("day not blocked yet", r.blocked === false);
  check("nothing changed by looking", b.state.emails.length === 0 && !b.row("EC-10001")[NEW_TIME]);
  check("yesterday refused", c.adminDayOffPreview("2026-10-07").ok === false);
  check("more than 30 days ahead refused", c.adminDayOffPreview("2026-11-09").ok === false && c.adminDayOffPreview("2026-11-07").ok === true);
  check("junk refused", c.adminDayOffPreview("8/10/2026").ok === false && c.adminDayOffPreview("2026-02-31").ok === false && c.adminDayOffPreview(undefined).ok === false);
  b.state.owner = "someone@else.com";
  let refused = 0;
  try { c.adminDayOffPreview("2026-10-08"); } catch (e) { refused++; }
  try { c.adminDayOff({ date: "2026-10-08" }); } catch (e) { refused++; }
  check("owner only", refused === 2);
})();

// ================= Doing it =================
(function doIt() {
  console.log("\n== Cancelling the day");
  const b = setup(); const c = b.ctx; seed(b);
  const r = c.adminDayOff({ date: "2026-10-08", reason: "illness" });
  check("no Dates in the reply", plainOk(b, r, "adminDayOff"));
  check("four jobs, three emailed", r.ok === true && r.count === 4 && r.emailed === 3, r);
  check("the one with no email is listed to contact", r.toContact.join() === "EC-10003", r.toContact);
  check("the day is blocked", r.blocked === true && blocks(b).length === 1 && /^Blocked: can't work \(illness\)$/.test(blocks(b)[0].title), blocks(b).map((e) => e.title));
  check("the block covers the whole day", blocks(b)[0].start.toISOString() === "2026-10-07T23:00:00.000Z" && blocks(b)[0].end.toISOString() === "2026-10-08T23:00:00.000Z");

  const row = b.row("EC-10001");
  check("marked as needing a new time", row[NEW_TIME] === "Asked 8 Oct (illness)", row[NEW_TIME]);
  check("noted in Changes", /8 Oct: we cancelled Thu 8 Oct, 9:00am \(illness\), asked them to pick a new time/.test(row.Changes), row.Changes);
  check("still open: not cancelled", !row["Cancelled at"] && !row["Cancellation fee"]);
  check("its calendar event is left alone", b.ctx.findBookingEvent_("EC-10001").getStartTime().toISOString() === "2026-10-08T08:00:00.000Z");
  check("all four marked", ["EC-10001", "EC-10002", "EC-10003", "EC-10007"].every((ref) => b.row(ref)[NEW_TIME]));
  check("the others untouched", ["EC-10004", "EC-10005", "EC-10006"].every((ref) => !b.row(ref)[NEW_TIME]));
  check("a job with no change link gets one", /^[0-9a-f]{32}$/.test(b.row("EC-10002")["Manage token"]), b.row("EC-10002")["Manage token"]);

  let mail = lastTo(b, "home@example.com");
  check("homeowner emailed", mail && mail.subject === "We need to move your clean on Thu 8 Oct (EC-10001)", mail && mail.subject);
  check("says sorry and why", mail.body.indexOf("Sorry, because of illness we can't make your clean on Thu 8 Oct, 9:00am (ref EC-10001).") !== -1, mail.body);
  check("free, and doesn't use their changes", /no charge, and it doesn't use up any of your online changes/.test(mail.body));
  check("link to pick a new time", mail.body.indexOf("Pick a new time: https://easycleansomerset.co.uk/my-booking.html?t=" + T1) !== -1);
  check("HTML button", mail.html.indexOf('href="https://easycleansomerset.co.uk/my-booking.html?t=' + T1 + '"') !== -1 && mail.html.indexOf(">Pick a new time</a>") !== -1);
  mail = lastTo(b, "agent@example.com");
  check("agent emailed about the property", mail.body.indexOf("we can't make the clean at 4 Mill Lane, Frome, BA11 1AA on Thu 8 Oct, 1:00pm") !== -1, mail.body);
  check("agent's link is the new one", mail.body.indexOf("my-booking.html?t=" + b.row("EC-10002")["Manage token"]) !== -1);
  check("job with its event deleted is emailed too", !!lastTo(b, "noevent@example.com"));
  check("nobody else emailed", !b.sentTo("started@example.com").length && !b.sentTo("cancelled@example.com").length && !b.sentTo("tomorrow@example.com").length);

  const owner = ownerMails(b).filter((m) => /Day off/.test(m.subject))[0];
  check("one summary email to Niall", owner && owner.subject === "[EasyClean] Day off Thu 8 Oct: 4 jobs to rebook", owner && owner.subject);
  check("says who to call", /EC-10003, Pat Phone.*\n  No email address\. Call or WhatsApp them on 07000 000333\./.test(owner.body), owner.body);
  check("and to tell the site contact", /Also tell the site contact, Terry Tenant, on 07000 000222\./.test(owner.body));
  check("and that the day is blocked", /The day is now blocked on the website/.test(owner.body));

  // Pressing it again: nothing more happens to the same jobs.
  const before = b.state.emails.length;
  const again = c.adminDayOff({ date: "2026-10-08", reason: "illness" });
  check("pressing again: no jobs left to move", again.ok === true && again.count === 0 && again.blocked === false);
  check("no second block", blocks(b).length === 1);
  check("no customer emailed twice", b.state.emails.length === before + 1); // just Niall's summary
})();

(function reasons() {
  console.log("\n== The reason given");
  let b = setup(); seed(b);
  b.ctx.adminDayOff({ date: "2026-10-08", reason: "vehicle" });
  check("vehicle", lastTo(b, "home@example.com").body.indexOf("Sorry, because of a problem with our vehicle we can't make your clean") !== -1);
  check("and the block says so", blocks(b)[0].title === "Blocked: can't work (vehicle problem)");
  b = setup(); seed(b);
  b.ctx.adminDayOff({ date: "2026-10-08", reason: "other" });
  check("no reason given", lastTo(b, "home@example.com").body.indexOf("Sorry, we can't make your clean on Thu 8 Oct") !== -1);
  check("sheet says so without a reason", b.row("EC-10001")[NEW_TIME] === "Asked 8 Oct");
  b = setup(); seed(b);
  b.ctx.adminDayOff({ date: "2026-10-08", reason: "<script>" });
  check("an unknown reason gives none", lastTo(b, "home@example.com").body.indexOf("Sorry, we can't make") !== -1);

  b = setup();
  const r = b.ctx.adminDayOff({ date: "2026-10-09" });
  check("a day with no jobs is just blocked", r.ok === true && r.count === 0 && blocks(b).length === 1 &&
    /There were no jobs booked that day/.test(ownerMails(b)[0].body));
  b = setup();
  b.ctx.adminAddBlock({ date: "2026-10-09", allDay: true, note: "holiday" });
  const pre = b.ctx.adminDayOffPreview("2026-10-09");
  check("an already blocked day is shown as blocked", pre.blocked === true);
  b.ctx.adminDayOff({ date: "2026-10-09" });
  check("and isn't blocked twice", blocks(b).length === 1);
  // A part-day block isn't the whole day.
  b = setup();
  b.ctx.adminAddBlock({ date: "2026-10-09", allDay: false, from: "09:00", to: "12:00", note: "dentist" });
  check("a few hours blocked doesn't count as the day", b.ctx.adminDayOffPreview("2026-10-09").blocked === false);
})();

// ================= While it waits for a new time =================
(function waiting() {
  console.log("\n== Waiting for a new time");
  const b = setup(); const c = b.ctx; seed(b);
  c.adminDayOff({ date: "2026-10-08", reason: "illness" });
  const sentBefore = b.state.emails.length;

  c.sendTodaysReminders_();
  const reminded = b.state.emails.slice(sentBefore).map((m) => m.to);
  check("no morning reminders for them", !reminded.some((to) => /home@|agent@|noevent@/.test(to)), reminded);

  const o = c.adminGetOverview();
  check("no Dates in the overview", plainOk(b, o, "adminGetOverview"));
  check("listed under Waiting for a new time", o.newTime.map((j) => j.reference).join() === "EC-10001,EC-10007,EC-10002,EC-10003", o.newTime.map((j) => j.reference));
  check("not under Today", !o.today.some((j) => j.needsNewTime));
  check("each says why", o.newTime[0].needsNewTime === "Asked 8 Oct (illness)");
  const job = c.adminGetJob(b.row("EC-10001")["Job token"]);
  check("the job page says so", job.needsNewTime === "Asked 8 Oct (illness)");

  // Tomorrow's job, cancelled the night before: no day-before reminder or site contact message.
  const t = setup("2026-10-08T18:00:00Z");
  t.addBooking({ Reference: "EC-20001", Email: "t@example.com", Timestamp: t.date("2026-10-01T09:00:00Z"), Channel: "Agent/Landlord", "Business name": "Acme",
    "Site contact name": "Terry", "Site contact phone": "07000 000444" }, "2026-10-09T08:00:00Z");
  t.ctx.adminDayOff({ date: "2026-10-09", reason: "vehicle" });
  const n = t.state.emails.length;
  t.ctx.sendDayBeforeReminders();
  check("no day-before reminder", t.state.emails.length === n);
  check("no site contact message", t.ctx.sendSiteContactDigest_(t.date("2026-10-08T18:00:00Z")) === 0);
})();

// ================= The customer picks a new time =================
(function rebook() {
  console.log("\n== The customer picks a new time");
  const b = setup(); const c = b.ctx;
  seed(b, { "Online moves": 2 }); // they'd already used both online moves
  c.adminDayOff({ date: "2026-10-08", reason: "illness" });
  // Lunchtime: their 9am has passed.
  b.setNow("2026-10-08T11:00:00Z");

  let p = c.getPublicBooking(T1);
  check("the page still lets them change it", p.canChange === true && p.notChangeableReason === null, p);
  check("with a move left, though both were used", p.movesLeft === 1, p.movesLeft);
  const slots = c.getRescheduleSlots(T1);
  check("new times offered", slots.ok === true && slots.slots.length > 0, slots.error);
  const s = slots.slots.filter((x) => /2026-10-14/.test(x.date || ""))[0] || slots.slots[0];
  const d = new Date(s.start);
  const date = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const r = c.rescheduleBookingPublic({ t: T1, date, time, earlyStart: true });
  check("moved", r.ok === true, r);
  const row = b.row("EC-10001");
  check("no longer needs a new time", !row[NEW_TIME]);
  check("didn't count as one of their moves", Number(row["Online moves"]) === 2, row["Online moves"]);
  check("noted as after we cancelled", /moved online by customer \(after we cancelled\) from Thu 8 Oct, 9:00am/.test(row.Changes), row.Changes);
  const owner = ownerMails(b).filter((m) => /Moved online: EC-10001/.test(m.subject))[0];
  check("Niall told it doesn't count", owner && /doesn't count as one of their online moves/.test(owner.body), owner && owner.body);
  check("back to normal: the page now follows the usual rules", c.getPublicBooking(T1).movesLeft === 0);

  // An ordinary booking whose time has passed still can't be changed.
  const o = setup("2026-10-08T11:00:00Z");
  o.addBooking({ Reference: "EC-30001", "Manage token": T1 }, "2026-10-08T08:00:00Z");
  check("an ordinary past booking still can't be changed", o.ctx.getPublicBooking(T1).notChangeableReason === "started");

  // Cancelling instead: no late-notice line for Niall.
  const x = setup(); seed(x);
  x.ctx.adminDayOff({ date: "2026-10-08", reason: "illness" });
  x.setNow("2026-10-08T07:30:00Z");
  check("they can cancel instead", x.ctx.cancelBookingPublic({ t: T1, reason: "Plans changed" }).ok === true && !!x.row("EC-10001")["Cancelled at"]);
  const om = ownerMails(x).filter((m) => /Cancelled online/.test(m.subject))[0];
  check("no late-notice line, it was our cancellation", om && om.body.indexOf("less than 24 hours") === -1, om && om.body);
})();

(function otherWays() {
  console.log("\n== Other ways it gets a new time");
  const b = setup(); const c = b.ctx; seed(b);
  c.adminDayOff({ date: "2026-10-08", reason: "illness" });

  // Edit job in the admin app.
  const token = b.row("EC-10003")["Job token"];
  const form = c.adminGetJobForEdit(token);
  form.lines = form.lines.map((l) => ({ desc: l.desc, qty: l.qty, unit: l.unit, mins: l.mins }));
  form.date = "2026-10-15"; form.time = "10:00";
  const u = c.adminUpdateJob(token, form);
  check("Edit job with a new time", u.ok === true, u);
  check("clears it", !b.row("EC-10003")[NEW_TIME]);

  // Dragged to a new day in Google Calendar.
  c.findBookingEvent_("EC-10002").setTime(b.date("2026-10-16T08:00:00Z"), b.date("2026-10-16T10:30:00Z"));
  c.syncOpenBookingTimes_();
  check("a drag in Google Calendar clears it", !b.row("EC-10002")[NEW_TIME]);
  check("an untouched one still needs a time", !!b.row("EC-10001")[NEW_TIME]);
})();

(function morningCheck() {
  console.log("\n== The morning check");
  const b = setup(); const c = b.ctx; seed(b);
  c.adminDayOff({ date: "2026-10-08", reason: "illness" });
  const issues = (now) => c.dailyHealthCheck_({ now: b.date(now), force: true }).issues.join(" | ");
  b.setNow("2026-10-10T06:00:00Z");
  check("not mentioned in the first few days", !/no new time/.test(issues("2026-10-10T06:00:00Z")));
  b.setNow("2026-10-12T06:00:00Z");
  const text = issues("2026-10-12T06:00:00Z");
  check("after 3 days, listed to chase", /4 bookings from days you cancelled still have no new time: EC-10001/.test(text), text);
  check("and not as waiting for sign-off", !/not signed off yet/.test(text) || !/EC-10001 \(/.test(text.split("not signed off yet")[1] || ""), text);
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nAll passed.");
process.exit(failures ? 1 : 0);
