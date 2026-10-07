/*
 * Checks of the booking system's own code (_backend/Code.gs), run in Node
 * with Google's services faked (see fake-google.js). Nothing here touches the
 * real calendar, sheet, Drive or email.
 *
 * From the repo root:
 *   node _tests/backend.test.js
 *
 * Prints PASS/FAIL per check and exits non-zero if anything failed. It needs
 * no npm install. This folder starts with "_", so it is never published.
 */
const { loadBackend, seedFigures } = require("./fake-google");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || detail === undefined ? "" : "  (" + JSON.stringify(detail) + ")"));
  if (!ok) failures++;
}
function throws(fn) { try { fn(); return false; } catch (e) { return String(e && e.message || e); } }

const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const jpeg = (label) => "data:image/jpeg;base64," + Buffer.from("fake-jpeg-" + label).toString("base64");

function agentRow(extra) {
  return Object.assign({
    Reference: "EC-20001", Name: "Pat Agent", "Business name": "Acme Lettings", Channel: "Agent/Landlord",
    "Payment method": "Invoice, 14 days", "Site contact name": "Pat Agent", "Site contact phone": "07000 000002",
    Total: "£300", Items: "3× Medium room: £135",
  }, extra || {});
}

// ================= Time on job =================
function timer() {
  console.log("\n== Time on job (FRE-194)");
  const b = loadBackend({ now: "2026-10-07T07:00:00Z" });
  const c = b.ctx;
  b.setUpSheet();

  check("parses estimate text", c.parseMinsText_("~1h 55m") === 115 && c.parseMinsText_("2h") === 120 && c.parseMinsText_("45 min") === 45 &&
    c.parseMinsText_("not specified") === null && c.parseMinsText_("") === null && c.parseMinsText_(undefined) === null);

  const v = b.addBooking({}, "2026-10-07T08:00:00Z");
  const token = v["Job token"];
  let job = c.adminGetJob(token);
  check("an older booking's estimate comes from its calendar event", job.estMins === 115, job.estMins);
  check("and is remembered in the sheet", b.row("EC-10001")["Est. mins"] === 115, b.row("EC-10001")["Est. mins"]);
  check("the job page data has no Dates in it", !throws(() => b.checkPlain(job, "adminGetJob")));
  check("before starting: no timer yet", job.startedMs === 0 && job.actualMins === 0);

  check("Finish before Start is refused", c.adminFinishJob(token).error === "Tap Start job first.");
  let r = c.adminStartJob(token);
  check("Start records the time", r.ok && r.timing.startedMs === b.date("2026-10-07T07:00:00Z").getTime() && r.timing.startedAt === "8:00am", r);
  check("Start writes Started at to the sheet", b.row("EC-10001")["Started at"] instanceof c.Date);
  b.advanceMinutes(10);
  const again = c.adminStartJob(token);
  check("Start again while running keeps the first start", again.ok && again.timing.startedMs === r.timing.startedMs);

  b.advanceMinutes(85);
  r = c.adminFinishJob(token);
  check("Finish records the minutes since Start", r.ok && r.timing.actualMins === 95 && r.timing.estMins === 115, r);
  check("the sheet has Finished at and Actual mins", b.row("EC-10001")["Actual mins"] === 95 && b.row("EC-10001")["Finished at"] instanceof c.Date);
  b.advanceMinutes(30);
  check("Finish again changes nothing", c.adminFinishJob(token).timing.actualMins === 95);
  job = c.adminGetJob(token);
  check("the job page shows the result", job.actualMins === 95 && job.finishedMs > 0 && job.estMins === 115);

  r = c.adminResetTimer(token);
  check("Reset clears the timer but keeps the estimate", r.ok && r.timing.startedMs === 0 && r.timing.estMins === 115 &&
    b.row("EC-10001")["Started at"] === "" && b.row("EC-10001")["Actual mins"] === "" && b.row("EC-10001")["Est. mins"] === 115);
  r = c.adminStartJob(token);
  check("Start after a reset starts a fresh timer", r.ok && r.timing.startedMs === b.date("2026-10-07T07:00:00Z").getTime() + 125 * 60000);

  check("a bad token is not found", c.adminStartJob("nope").error === "Couldn't find that job.");
  check("every timer call needs the owner", ["adminStartJob", "adminFinishJob", "adminResetTimer"].every((fn) => {
    const o = loadBackend({ owner: false });
    return throws(() => o.ctx[fn]("x")) === "not_authorised";
  }));
  check("locks are all released", b.state.locksHeld === 0, b.state.locksHeld);

  // A new website booking stores its estimate in minutes.
  const w = loadBackend();
  w.setUpSheet();
  w.ctx.appendCustomerRow({ name: "Web Customer", estTime: "~2h 25m", payment: "Cash", total: "£130", items: "x" }, "EC-30001", "Thu 8 Oct, 9:00am", "t".repeat(32));
  check("a booking made now stores the estimate in minutes", w.row("EC-30001")["Est. mins"] === 145, w.row("EC-30001")["Est. mins"]);

  // Sign-off finishes a timer left running, if it is within a working day.
  const s = loadBackend({ now: "2026-10-07T07:00:00Z" });
  s.setUpSheet();
  const a = s.addBooking({ Reference: "EC-40001" }, "2026-10-07T08:00:00Z");
  s.ctx.adminStartJob(a["Job token"]);
  s.advanceMinutes(75);
  check("sign-off works", s.ctx.adminCompleteJob(a["Job token"], "", "no one home").ok === true);
  check("a job left running is finished at sign-off", s.row("EC-40001")["Actual mins"] === 75 && s.row("EC-40001")["Finished at"] instanceof s.ctx.Date, s.row("EC-40001")["Actual mins"]);
  check("a signed-off job can't be started", s.ctx.adminStartJob(a["Job token"]).error === "This job is already signed off.");

  const late = loadBackend({ now: "2026-10-07T07:00:00Z" });
  late.setUpSheet();
  const l = late.addBooking({ Reference: "EC-40002" }, "2026-10-07T08:00:00Z");
  late.ctx.adminStartJob(l["Job token"]);
  late.advanceMinutes(60 * 20);
  late.ctx.adminCompleteJob(l["Job token"], "", "signed next morning");
  check("a timer left running overnight is not turned into a long job", late.row("EC-40002")["Actual mins"] === "" && late.row("EC-40002")["Finished at"] === "");

  const k = loadBackend();
  k.setUpSheet();
  const cancelled = k.addBooking({ Reference: "EC-40003", "Cancelled at": k.date("2026-10-06T10:00:00Z") });
  check("a cancelled booking can't be started", k.ctx.adminStartJob(cancelled["Job token"]).error === "This booking is cancelled.");
}

// ================= Photos =================
function photos() {
  console.log("\n== Photos (FRE-194)");
  const b = loadBackend({ now: "2026-10-07T07:00:00Z" });
  const c = b.ctx;
  b.setUpSheet();
  const v = b.addBooking({}, "2026-10-07T08:00:00Z");
  const token = v["Job token"];

  check("before any photo there is no folder", c.adminGetJob(token).photosFolderUrl === "" && b.state.folders.length === 0);
  let r = c.adminAddPhoto(token, "before", jpeg("1"));
  const root = b.state.folders.filter((f) => f.name === "EasyClean Somerset — Job photos")[0];
  check("the first photo makes a job folder inside the photos folder", r.ok && root && root.children.length === 1 && root.children[0].name === "EC-10001 Sam Customer", root && root.children.map((f) => f.name));
  const folder = root.children[0];
  check("the file name has the reference, Before and a number", /^EC-10001-before-\d{8}-\d{6}-1\.jpg$/.test(folder.files[0].getName()), folder.files[0].getName());
  check("the photo bytes are saved as sent", Buffer.from(folder.files[0].getBlob().getBytes().map((x) => x & 255)).toString() === "fake-jpeg-1");
  check("the folder and photo are private", folder.sharing === "PRIVATE" && folder.files[0].getSharingAccess() === "PRIVATE" && root.sharing === "PRIVATE");
  check("the sheet keeps the folder link", b.row("EC-10001")["Photos folder"] === folder.getUrl());

  b.advanceMinutes(1);
  r = c.adminAddPhoto(token, "Before", jpeg("2"));
  check("a second Before photo is number 2", r.ok && r.photoBefore === 2 && r.photoAfter === 0 && /-before-\d{8}-\d{6}-2\.jpg$/.test(folder.files[1].getName()), r);
  r = c.adminAddPhoto(token, "after", jpeg("3"));
  check("an After photo is counted separately", r.ok && r.photoBefore === 2 && r.photoAfter === 1 && /-after-\d{8}-\d{6}-1\.jpg$/.test(folder.files[2].getName()), r);
  check("one folder is used for all of them", root.children.length === 1 && folder.files.length === 3);
  const job = c.adminGetJob(token);
  check("the job page shows the counts and folder link", job.photoBefore === 2 && job.photoAfter === 1 && job.photosFolderUrl === folder.getUrl());
  check("the job page data has no Dates in it", !throws(() => b.checkPlain(job, "adminGetJob")));

  check("a made-up kind is refused", c.adminAddPhoto(token, "during", jpeg("x")).error === "Pick Before or After.");
  check("something that isn't a JPEG is refused", c.adminAddPhoto(token, "before", "data:text/html;base64,PGI+").error === "That doesn't look like a photo." &&
    c.adminAddPhoto(token, "before", "").error === "That doesn't look like a photo.");
  check("a huge photo is refused", c.adminAddPhoto(token, "before", "data:image/jpeg;base64," + "A".repeat(6000001)).error === "That photo is too big.");
  check("a bad token is not found, and makes no folder", c.adminAddPhoto("nope", "before", jpeg("y")).error === "Couldn't find that job." && root.children.length === 1);
  check("refused photos were not saved", folder.files.length === 3);
  check("photo calls need the owner", throws(() => loadBackend({ owner: false }).ctx.adminAddPhoto("x", "before", jpeg("z"))) === "not_authorised");

  const gone = b.addBooking({ Reference: "EC-10002", Name: "Gone Folder" }, "2026-10-07T12:00:00Z");
  c.adminAddPhoto(gone["Job token"], "before", jpeg("g1"));
  b.state.foldersById[b.row("EC-10002")["Photos folder"].split("/").pop()].setTrashed(true);
  r = c.adminAddPhoto(gone["Job token"], "before", jpeg("g2"));
  check("if the folder is deleted, the next photo starts a new one", r.ok && r.photoBefore === 1 && b.row("EC-10002")["Photos folder"] !== "" , r);
  check("a deleted folder doesn't break the job page", !throws(() => c.adminGetJob(gone["Job token"])));

  // The folder name never contains characters Drive dislikes.
  const odd = b.addBooking({ Reference: "EC-10003", Name: 'A/B: "Quote" <x>' });
  c.adminAddPhoto(odd["Job token"], "after", jpeg("o"));
  check("odd characters in a name are cleaned from the folder name", /^EC-10003 A B Quote x$/.test(root.children[root.children.length - 1].name), root.children.map((f) => f.name));

  // Photos can be added after sign-off (a late After photo) and on cancelled jobs (no access).
  c.adminCompleteJob(token, "", "no one home");
  r = c.adminAddPhoto(token, "after", jpeg("late"));
  check("a late After photo can still be added after sign-off", r.ok && r.photoAfter === 2, r);
  const cx = b.addBooking({ Reference: "EC-10004", "Cancelled at": b.date("2026-10-06T10:00:00Z") });
  check("and a photo can be added to a cancelled job", c.adminAddPhoto(cx["Job token"], "before", jpeg("cx")).ok === true);

  const pdf = b.ctx.adminSetPhotosInPdf(token, false);
  check("the PDF tick is saved as No, and back to blank", pdf.ok && b.row("EC-10001")["Photos in PDF"] === "No" && c.adminSetPhotosInPdf(token, true).ok && b.row("EC-10001")["Photos in PDF"] === "");
  check("locks are all released", b.state.locksHeld === 0, b.state.locksHeld);
}

// ================= Photos in the agent completion PDF =================
function pdfPhotos() {
  console.log("\n== Photos in the agent completion PDF (FRE-194)");
  const run = (setup) => {
    const b = loadBackend({ now: "2026-10-07T07:00:00Z" });
    b.setUpSheet();
    const v = b.addBooking(agentRow(), "2026-10-07T08:00:00Z");
    setup && setup(b, v);
    return { b, v };
  };
  const completionHtml = (b) => {
    const mail = b.state.emails.filter((e) => e.subject && /Invoice|invoice|complete|Thank/i.test(e.subject))[0] || b.state.emails[0];
    const pdf = mail && mail.attachments.filter((a) => /^Job-completion-/.test(a.getName()))[0];
    return pdf ? pdf.html : null;
  };
  const count = (html, cls) => (html.match(new RegExp('class="' + cls + '"', "g")) || []).length;

  let { b, v } = run((b, v) => {
    b.ctx.adminAddPhoto(v["Job token"], "before", jpeg("b1"));
    b.advanceMinutes(1);
    b.ctx.adminAddPhoto(v["Job token"], "after", jpeg("a1"));
  });
  let r = b.ctx.adminCompleteJob(v["Job token"], SIGNATURE, "");
  let html = completionHtml(b);
  check("sign-off works with photos", r.ok === true, r);
  check("an agent's completion PDF includes the Before and After photos", html && count(html, "ph") === 2 && html.indexOf("Photos taken on the day") !== -1 && html.indexOf(">Before<") !== -1 && html.indexOf(">After<") !== -1);
  check("the photos in the PDF are the saved ones", html.indexOf(Buffer.from("fake-jpeg-b1").toString("base64")) !== -1 && html.indexOf(Buffer.from("fake-jpeg-a1").toString("base64")) !== -1);
  check("the signature is still in the PDF", html.indexOf(SIGNATURE) !== -1);

  ({ b, v } = run((b, v) => {
    for (let i = 1; i <= 6; i++) { b.advanceMinutes(1); b.ctx.adminAddPhoto(v["Job token"], "before", jpeg("many" + i)); }
  }));
  b.ctx.adminCompleteJob(v["Job token"], SIGNATURE, "");
  html = completionHtml(b);
  check("at most 4 Before photos go in the PDF, oldest first", count(html, "ph") === 4 && html.indexOf(Buffer.from("fake-jpeg-many1").toString("base64")) !== -1 && html.indexOf(Buffer.from("fake-jpeg-many5").toString("base64")) === -1);

  ({ b, v } = run((b, v) => {
    b.ctx.adminAddPhoto(v["Job token"], "before", jpeg("off"));
    b.ctx.adminSetPhotosInPdf(v["Job token"], false);
  }));
  b.ctx.adminCompleteJob(v["Job token"], SIGNATURE, "");
  html = completionHtml(b);
  check("with the tick turned off, no photos go in the PDF", html && count(html, "ph") === 0 && html.indexOf("Photos taken") === -1);

  ({ b, v } = run());
  b.ctx.adminCompleteJob(v["Job token"], SIGNATURE, "");
  html = completionHtml(b);
  check("an agent job with no photos has no photos section", html && html.indexOf("Photos taken") === -1);

  // A homeowner's PDF never gets photos.
  const h = loadBackend({ now: "2026-10-07T07:00:00Z" });
  h.setUpSheet();
  const hv = h.addBooking({ Reference: "EC-50001" }, "2026-10-07T08:00:00Z");
  h.ctx.adminAddPhoto(hv["Job token"], "before", jpeg("home"));
  h.ctx.adminCompleteJob(hv["Job token"], SIGNATURE, "");
  html = completionHtml(h);
  check("a homeowner's completion PDF has no photos", html && count(html, "ph") === 0);

  // If the photos can't be read, or make the PDF fail, the PDF still goes out.
  ({ b, v } = run((b, v) => { b.ctx.adminAddPhoto(v["Job token"], "before", jpeg("e")); }));
  b.ctx.photosForPdf_ = () => { throw new Error("Drive is down"); };
  r = b.ctx.adminCompleteJob(v["Job token"], SIGNATURE, "");
  html = completionHtml(b);
  check("if the photos can't be read, the job is still signed off with a PDF", r.ok && html && count(html, "ph") === 0);

  ({ b, v } = run((b, v) => { b.ctx.adminAddPhoto(v["Job token"], "before", jpeg("big")); }));
  const original = b.ctx.buildJobCompletionPdfBlob;
  b.ctx.buildJobCompletionPdfBlob = function (vv, n, d, sig, photos) { if (photos) throw new Error("PDF too large"); return original(vv, n, d, sig, photos); };
  r = b.ctx.adminCompleteJob(v["Job token"], SIGNATURE, "");
  html = completionHtml(b);
  check("if the PDF fails with photos, it is built again without them", r.ok && html && count(html, "ph") === 0 && html.indexOf(SIGNATURE) !== -1);
  check("and the problem is noted for the morning check", JSON.parse(b.state.props.PROBLEM_LOG).some((p) => /Job completion PDF failed/.test(p.where)));
  check("the completion PDF is saved to Drive and linked", /^https:\/\/drive\.google\.com/.test(b.row("EC-20001")["Completion PDF"]), b.row("EC-20001")["Completion PDF"]);
}

// ================= Income column =================
function income() {
  console.log("\n== Income column (FRE-187)");
  const b = loadBackend({ now: "2026-10-07T07:00:00Z" });
  const c = b.ctx;
  b.setUpSheet();

  check("a signed-off job adds its total", c.incomeFor_({ "Completed at": b.date("2026-10-05T10:00:00Z"), Total: "£140", "Payment method": "Cash" }).amount === 140);
  check("a total with pence", c.incomeFor_({ "Completed at": b.date("2026-10-05T10:00:00Z"), Total: "£99.50", "Payment method": "Cash" }).amount === 99.5);
  check("a total the sheet turned into a number", c.incomeFor_({ "Completed at": b.date("2026-10-05T10:00:00Z"), Total: 140, "Payment method": "Cash" }).amount === 140);
  check("a No charge job adds nothing", c.incomeFor_({ "Completed at": b.date("2026-10-05T10:00:00Z"), Total: "£90", "Payment method": "No charge" }).amount === 0);
  check("a cancelled booking adds its fee, not its total", c.incomeFor_({ "Cancelled at": b.date("2026-10-05T10:00:00Z"), Total: "£200", "Cancellation fee": "£25" }).amount === 25);
  check("a fee the sheet turned into a number", c.incomeFor_({ "Cancelled at": b.date("2026-10-05T10:00:00Z"), Total: "£200", "Cancellation fee": 25 }).amount === 25);
  check("a cancelled booking with no fee adds nothing", c.incomeFor_({ "Cancelled at": b.date("2026-10-05T10:00:00Z"), Total: "£200", "Cancellation fee": "" }).amount === 0);
  check("a job not done yet adds nothing and has no row", c.incomeFor_({ Total: "£140" }) === null);
  check("the day it counts on is the UK day", c.incomeFor_({ "Completed at": b.date("2026-06-30T23:30:00Z"), Total: "£1" }).key === "2026-07-01");

  // Sign off a job, cancel with a fee, cancel without one, cancel when we cancel.
  const done = b.addBooking({ Reference: "EC-60001" }, "2026-10-07T08:00:00Z");
  c.adminCompleteJob(done["Job token"], SIGNATURE, "");
  check("sign-off writes the Income", b.row("EC-60001").Income === 90, b.row("EC-60001").Income);
  check("the Income column is formatted as money", b.sheet().formatAt(b.sheet().rows.findIndex((r) => r.indexOf("EC-60001") !== -1) + 1, b.sheet().rows[0].indexOf("Income") + 1) === "£#,##0.00");

  const free = b.addBooking({ Reference: "EC-60002", "Payment method": "No charge", Total: "£120" }, "2026-10-08T08:00:00Z");
  c.adminCompleteJob(free["Job token"], SIGNATURE, "");
  check("a No charge job signs off with Income 0", b.row("EC-60002").Income === 0);

  const late = b.addBooking({ Reference: "EC-60003", Total: "£200" }, "2026-10-07T12:00:00Z");
  let r = c.adminCancelJob(late["Job token"], { reason: "noaccess", chargeFee: true, emailCustomer: false });
  check("cancelling with a fee writes the fee as Income", r.ok && b.row("EC-60003").Income === 25 && b.row("EC-60003")["Cancellation fee"] === 25, [r, b.row("EC-60003").Income]);
  const plain = b.addBooking({ Reference: "EC-60004", Total: "£150" }, "2026-10-20T08:00:00Z");
  c.adminCancelJob(plain["Job token"], { reason: "customer", emailCustomer: false });
  check("cancelling with no fee writes Income 0", b.row("EC-60004").Income === 0);
  const ours = b.addBooking({ Reference: "EC-60005", Total: "£150" }, "2026-10-21T08:00:00Z");
  c.adminCancelJob(ours["Job token"], { reason: "us", chargeFee: true, emailCustomer: false });
  check("when we cancel there is never a fee or income", b.row("EC-60005").Income === 0 && b.row("EC-60005")["Cancellation fee"] === "");

  const rows = ["EC-60001", "EC-60002", "EC-60003", "EC-60004", "EC-60005"].map((x) => b.row(x));
  const naive = rows.reduce((s, x) => s + c.parseMoney_(x.Total), 0);
  const fixed = rows.reduce((s, x) => s + x.Income, 0);
  check("adding up Income gives the real income, adding up Total overstates it", fixed === 115 && naive === 710, [fixed, naive]);

  // Backfill for rows made before this version.
  const old1 = b.addBooking({ Reference: "EC-70001", "Completed at": b.date("2026-09-01T10:00:00Z"), Total: "£140" });
  const old2 = b.addBooking({ Reference: "EC-70002", "Cancelled at": b.date("2026-09-02T10:00:00Z"), Total: "£200", "Cancellation fee": 25 });
  const old3 = b.addBooking({ Reference: "EC-70003", "Cancelled at": b.date("2026-09-03T10:00:00Z"), Total: "£150" });
  const open = b.addBooking({ Reference: "EC-70004", Total: "£150" });
  const kept = b.addBooking({ Reference: "EC-70005", "Completed at": b.date("2026-09-04T10:00:00Z"), Total: "£100", Income: 80 });
  c.backfillIncomeColumn();
  check("backfill fills Income for done and cancelled rows", b.row("EC-70001").Income === 140 && b.row("EC-70002").Income === 25 && b.row("EC-70003").Income === 0, ["EC-70001", "EC-70002", "EC-70003"].map((x) => b.row(x).Income));
  check("backfill leaves a job not done yet blank", b.row("EC-70004").Income === "");
  check("backfill doesn't overwrite an Income already there", b.row("EC-70005").Income === 80);
  const before = JSON.stringify(b.sheet().rows);
  c.backfillIncomeColumn();
  check("running the backfill again changes nothing", JSON.stringify(b.sheet().rows) === before);
  check("the backfill says what it did", b.logs.some((l) => /Income filled in for 0 row/.test(l)));
}

// ================= Figures =================
function figures() {
  console.log("\n== Monthly figures (FRE-187)");
  const b = loadBackend({ now: "2026-10-02T07:00:00Z" });
  const c = b.ctx;
  b.setUpSheet();
  seedFigures(b);
  const f = c.computeFigures_(c.readFigureRows_(b.sheet()), b.date("2026-10-02T07:00:00Z"));
  const p = f.lastMonth;

  check("last month is September 2026", p.label === "September 2026");
  check("jobs completed in September, including the No charge one", p.jobs === 3, p.jobs);
  check("job revenue leaves out the cancelled bookings' totals", p.jobRevenue === 440, p.jobRevenue);
  check("cancellation fees are counted on their own", p.feeCount === 1 && p.feeAmount === 25);
  check("total income is jobs plus fees", p.income === 465, p.income);
  check("average job is over jobs that were paid for", p.paidJobs === 2 && p.jobRevenue / p.paidJobs === 220);
  check("cancellations by reason", p.cancelled.total === 3 && p.cancelled.customer === 1 && p.cancelled.noaccess === 1 && p.cancelled.us === 1, p.cancelled);
  check("bookings made, by channel and by how they came in", p.bookings.total === 6 && p.bookings.consumer === 5 && p.bookings.agent === 1 && p.bookings.website === 5 && p.bookings.admin === 1, p.bookings);
  check("referral codes are tidied and counted", JSON.stringify(p.referrals) === JSON.stringify({ FRIEND10: 2 }), p.referrals);
  check("time on job: timed jobs only", p.timing.n === 1 && p.timing.actual === 100 && p.timing.est === 120, p.timing);
  check("30 days in September", p.days === 30);

  check("this month so far", f.thisMonth.label === "This month so far (October 2026)" && f.thisMonth.jobs === 1 && f.thisMonth.jobRevenue === 80 && f.thisMonth.bookings.total === 2 && f.thisMonth.days === 2, f.thisMonth);
  check("year to date runs from 6 April", f.ytd.label === "Year to date (since 6 Apr 2026)" && f.ytd.jobs === 5 && f.ytd.jobRevenue === 720 && f.ytd.income === 745, [f.ytd.label, f.ytd.jobs, f.ytd.jobRevenue]);
  check("a job before 6 April is not in the year to date", f.ytd.jobRevenue < 720 + 500);
  check("last 12 months leaves out a job a year and a day ago, and the day itself", f.rolling.income === 1295, f.rolling.income);
  check("unpaid invoices and what is overdue", f.unpaid.count === 2 && f.unpaid.amount === 325 && f.unpaid.overdueCount === 2 && f.unpaid.overdueAmount === 325, f.unpaid);
  check("a row with no usable date is flagged", f.noDate === 0);

  const rows = c.periodRows_(p);
  const get = (label) => (rows.filter((r) => r[0] === label)[0] || [])[1];
  check("the lines read well", get("Jobs completed") === "3" && get("Total income") === "£465" && get("Average job") === "£220 (target £140)" &&
    get("Jobs a week") === "0.7 (target 5 to 7)" && get("Cancellation and call-out fees") === "£25 (1)" &&
    get("Cancelled bookings") === "3 (customer 1, no access 1, we cancelled 1)" && get("Referral codes") === "FRIEND10 x2" &&
    get("Time on job") === "1 timed, average 1h 40m against an estimate of 2h", rows);

  const early = (c.periodRows_(f.thisMonth).filter((r) => r[0] === "Jobs a week")[0] || [])[1];
  check("jobs a week isn't worked out from a couple of days", early === "too early to say (target 5 to 7)", early);

  const sections = c.figureSections_(f, false);
  const vat = sections.filter((s) => /VAT/.test(s.title))[0];
  check("VAT section shows turnover against the threshold", vat.rows[0][1] === "£1,295" && vat.rows[1][1] === "£90,000" && vat.rows[2][1] === "1.4%" && vat.rows[3][1] === "£88,705", vat.rows);
  check("no VAT warning when well under", vat.note.indexOf("Over 80%") === -1);
  check("email has last month, year to date, VAT and unpaid, not this month", sections.map((s) => s.title).join("|") === "September 2026|Year to date (since 6 Apr 2026)|VAT threshold, last 12 months|Unpaid now", sections.map((s) => s.title));

  // A bad row is flagged rather than breaking the figures.
  b.addBooking({ Reference: "EC-94", "Completed at": "garbage", Total: "£10" });
  const f2 = c.computeFigures_(c.readFigureRows_(b.sheet()), b.date("2026-10-02T07:00:00Z"));
  check("a signed-off row with an unreadable date is left out and flagged", f2.noDate === 1 && f2.lastMonth.income === 465 && c.figureSections_(f2, false).some((s) => s.title === "Needs a look"));

  // The VAT warning near the threshold, and tax year before 6 April.
  const near = loadBackend({ now: "2026-10-02T07:00:00Z" });
  near.setUpSheet();
  near.addBooking({ Reference: "EC-95", "Completed at": near.date("2026-09-05T10:00:00Z"), Total: "£75000", "Payment method": "Cash" });
  const fn = near.ctx.computeFigures_(near.ctx.readFigureRows_(near.sheet()), near.date("2026-10-02T07:00:00Z"));
  const nearVat = near.ctx.figureSections_(fn, false).filter((s) => /VAT/.test(s.title))[0];
  check("over 80% of the threshold adds a warning", nearVat.rows[2][1] === "83.3%" && /Over 80%/.test(nearVat.note), nearVat);
  check("before 6 April the year to date starts the April before", near.ctx.yearStartKey_("2027-03-31") === "2026-04-06" && near.ctx.yearStartKey_("2026-04-06") === "2026-04-06" && near.ctx.yearStartKey_("2026-04-05") === "2025-04-06");
  check("month helpers cross the year end", near.ctx.monthStartKey_("2027-01-15", -1) === "2026-12-01" && near.ctx.monthStartKey_("2026-12-31", 0) === "2026-12-01");
  check("money is formatted with commas and only needed pence", near.ctx.gbp_(1295) === "£1,295" && near.ctx.gbp_(99.5) === "£99.50" && near.ctx.gbp_(1234567) === "£1,234,567" && near.ctx.gbp_(0) === "£0");
}

function figuresEmail() {
  console.log("\n== Monthly figures email (FRE-187)");
  const b = loadBackend({ now: "2026-10-02T07:00:00Z" });
  const c = b.ctx;
  b.setUpSheet();
  seedFigures(b);
  const figuresMail = () => b.state.emails.filter((e) => /Figures for/.test(e.subject));

  check("the first time it runs mid-month it sends nothing", c.sendMonthlyFigures_() === false && figuresMail().length === 0);
  check("it notes the month so the first email is the next 1st", b.state.props.FIGURES_LAST_MONTH === "2026-09");

  b.setNow("2026-11-01T07:10:00Z");
  check("on the 1st it sends", c.sendMonthlyFigures_() === true && figuresMail().length === 1);
  const mail = figuresMail()[0];
  check("it goes to the owner with the month and headline numbers", mail.to === "owner@example.com" && mail.subject === "[EasyClean] Figures for October 2026: 1 job, £80", mail.subject);
  check("the month is remembered", b.state.props.FIGURES_LAST_MONTH === "2026-10");
  check("a second run the same day sends nothing more", c.sendMonthlyFigures_() === false && figuresMail().length === 1);
  b.setNow("2026-11-02T07:10:00Z");
  check("and nor the next day", c.sendMonthlyFigures_() === false && figuresMail().length === 1);

  b.state.props.FIGURES_LAST_MONTH = "2026-09";
  b.setNow("2026-11-03T07:10:00Z");
  check("if the 1st was missed, it sends on the next morning that runs", c.sendMonthlyFigures_() === true && figuresMail().length === 2);

  b.state.emails.length = 0;
  b.setNow("2026-10-02T07:00:00Z");
  check("a preview sends last month's figures now", c.sendMonthlyFigures_({ force: true }) === true);
  const body = figuresMail()[0].body;
  check("a preview doesn't touch the monthly marker", b.state.props.FIGURES_LAST_MONTH === "2026-10");
  check("the email subject for September", figuresMail()[0].subject === "[EasyClean] Figures for September 2026: 3 jobs, £465", figuresMail()[0].subject);
  check("the email says how income is counted", /counted on the day a job was signed off/.test(body));
  check("the email has the numbers", /SEPTEMBER 2026\nJobs completed: 3\nJob revenue: £440\nCancellation and call-out fees: £25 \(1\)\nTotal income: £465/.test(body), body.slice(0, 400));
  check("the email has year to date, VAT and unpaid", /YEAR TO DATE \(SINCE 6 APR 2026\)/.test(body) && /Turnover: £1,295/.test(body) && /Unpaid invoices: 2 \(£325\)/.test(body) && /Overdue: 2 \(£325\)/.test(body));
  check("the email has bookings by channel and referral code", /Bookings made: 6 \(homeowner 5, landlord or agent 1\)/.test(body) && /Referral codes: FRIEND10 x2/.test(body));
  check("the email has the targets", /\(target £140\)/.test(body) && /\(target 5 to 7\)/.test(body));
  check("no em dashes in the email", body.indexOf("—") === -1 && figuresMail()[0].subject.indexOf("—") === -1);

  // Through the daily trigger.
  const d = loadBackend({ now: "2026-11-01T07:05:00Z" });
  d.setUpSheet();
  seedFigures(d);
  d.state.props.FIGURES_LAST_MONTH = "2026-09";
  d.ctx.sendDayOfReminders();
  check("the daily trigger sends the figures on the 1st", d.state.emails.some((e) => /Figures for October 2026/.test(e.subject)));
  const before = d.state.emails.length;
  d.ctx.sendDayOfReminders();
  check("and not again the same day", d.state.emails.filter((e) => /Figures for/.test(e.subject)).length === 1 && d.state.emails.length >= before);

  // A failure in the figures doesn't stop the rest of the morning job.
  const f = loadBackend({ now: "2026-11-01T07:05:00Z" });
  f.setUpSheet();
  f.ctx.computeFigures_ = () => { throw new Error("boom"); };
  f.state.props.FIGURES_LAST_MONTH = "2026-09";
  check("a failure in the figures doesn't stop the morning job", !throws(() => f.ctx.sendDayOfReminders()));
  check("and it is reported in the morning check email", f.state.emails.some((e) => /Booking system check/.test(e.subject) && /Monthly figures email failed/.test(e.body)),
    f.state.emails.map((e) => e.subject));
}

function figuresTab() {
  console.log("\n== Figures tab (FRE-187)");
  const b = loadBackend({ now: "2026-10-02T07:00:00Z" });
  b.setUpSheet();
  seedFigures(b);
  const r = b.ctx.adminGetFigures();
  check("the tab's data has this month first, with no Dates", r.ok && r.sections[0].title === "This month so far (October 2026)" && !throws(() => b.checkPlain(r, "adminGetFigures")), r.sections && r.sections.map((s) => s.title));
  check("the tab has the VAT bar", r.sections.some((s) => typeof s.bar === "number"));
  check("the tab needs the owner", throws(() => loadBackend({ owner: false }).ctx.adminGetFigures()) === "not_authorised");
  check("with no sheet set up it says so", loadBackend().ctx.adminGetFigures().error === "no_sheet");
}

timer();
photos();
pdfPhotos();
income();
figures();
figuresEmail();
figuresTab();
console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
process.exit(failures ? 1 : 0);
