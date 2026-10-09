/*
 * FRE-220 and FRE-217: the daily backup of the customer sheet, and review
 * requests that ask for a Google review first with Trustpilot second.
 *
 * From the repo root:
 *   node _tests/backup-and-reviews.test.js
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

const GOOGLE = "https://g.page/r/CUP3ss-4Yk11EBM/review";
const TRUSTPILOT = "https://uk.trustpilot.com/review/easycleansomerset.co.uk";
const SIGNATURE = "data:image/png;base64,iVBORw0KGgo=";

// Fri 9 Oct 2026, 7:00am UK time.
const NOW = "2026-10-09T06:00:00Z";
function setup(now) {
  const b = loadBackend({ now: now || NOW });
  b.setUpSheet();
  return b;
}
const backups = (b) => {
  const folder = b.state.folders.filter((f) => f.name === "EasyClean Somerset backups")[0];
  return folder ? folder.files : [];
};
const live = (files) => files.filter((f) => !f.trashed).map((f) => f.getName()).sort();

// ================= Daily backup =================
(function backup() {
  console.log("\n== Daily backup of the customer sheet (FRE-220)");
  const b = setup(); const c = b.ctx;

  let r = c.backupCustomerSheet_();
  check("makes today's copy", r.made === true && live(backups(b)).join() === "Customer sheet backup 2026-10-09", live(backups(b)));
  check("of the customer sheet itself", backups(b)[0].blob.sourceId === b.state.props.customerSheetId);
  check("the folder is remembered in Script Properties", !!b.state.props.BACKUP_FOLDER_ID);
  check("the folder is private", b.state.folders.filter((f) => f.name === "EasyClean Somerset backups")[0].sharing === "PRIVATE");
  check("and the time is noted", b.state.props.BACKUP_LAST_AT === "2026-10-09T06:00:00.000Z", b.state.props.BACKUP_LAST_AT);

  r = c.backupCustomerSheet_();
  check("a second run the same day doesn't copy again", r.made === false && backups(b).length === 1);

  // Older backups, a file that only looks like one, and something else in the folder.
  const folder = b.state.foldersById[b.state.props.BACKUP_FOLDER_ID];
  ["2026-09-01", "2026-09-08", "2026-09-09", "2026-09-10", "2026-10-08"].forEach((d) => folder.createFile({ name: "Customer sheet backup " + d }));
  folder.createFile({ name: "Customer sheet backup 2026-09-01 (my copy)" });
  folder.createFile({ name: "Notes" });

  b.setNow("2026-10-10T06:00:00Z");
  r = c.backupCustomerSheet_();
  check("next day: a new copy", r.made === true);
  check("copies more than 30 days old go to the bin", r.removed === 3, r.removed);
  const left = live(backups(b));
  check("keeps 30 days of backups", left.indexOf("Customer sheet backup 2026-09-10") !== -1 && left.indexOf("Customer sheet backup 2026-09-09") === -1 &&
    left.indexOf("Customer sheet backup 2026-09-08") === -1, left);
  check("never bins a file it didn't name", left.indexOf("Notes") !== -1 && left.indexOf("Customer sheet backup 2026-09-01 (my copy)") !== -1, left);
  check("binned, not deleted (Drive keeps them in the bin)", backups(b).filter((f) => f.trashed).length === 3);

  // Folder deleted by hand: a new one is made.
  folder.setTrashed(true);
  b.setNow("2026-10-11T06:00:00Z");
  r = c.backupCustomerSheet_();
  const newId = b.state.props.BACKUP_FOLDER_ID;
  check("a deleted folder is made again", r.made === true && newId !== folder.id && b.state.foldersById[newId].files.length === 1);

  // No customer sheet yet: nothing to do, nothing breaks.
  const empty = loadBackend({ now: NOW });
  check("no customer sheet: no backup, no error", empty.ctx.backupCustomerSheet_().made === false && !empty.state.props.BACKUP_FOLDER_ID);
})();

(function morningRun() {
  console.log("\n== The morning job backs up first");
  const b = setup(); const c = b.ctx;
  b.addBooking({ Reference: "EC-20001" }, "2026-10-09T08:00:00Z");
  let order = [];
  const sync = c.syncOpenBookingTimes_;
  c.syncOpenBookingTimes_ = function () { order.push(b.state.copies ? "after backup" : "before backup"); return sync.apply(this, arguments); };
  c.sendDayOfReminders();
  check("the morning job makes the backup", live(backups(b)).length === 1);
  check("before anything else writes to the sheet", order[0] === "after backup", order);

  // A backup failure doesn't stop the reminders.
  const f = setup(); const fc = f.ctx;
  f.addBooking({ Reference: "EC-20002" }, "2026-10-09T08:00:00Z");
  f.ctx.DriveApp.getFileById = () => { throw new Error("Drive is down"); };
  fc.sendDayOfReminders();
  check("a failed backup doesn't stop the morning reminders", f.sentTo("sam@example.com").length === 1, f.sentTo("sam@example.com").map((e) => e.subject));
  const report = f.sentTo("owner@example.com").filter((m) => /Booking system check/.test(m.subject))[0];
  check("and it's reported in the morning check", report && /Backing up the customer sheet failed: Drive is down/.test(report.body), report && report.body);
})();

(function healthCheck() {
  console.log("\n== The morning check watches the backup");
  const b = setup(); const c = b.ctx;
  const issues = () => c.dailyHealthCheck_({ force: true }).issues.join(" | ");
  check("no backup yet: says so, and how to make one", /hasn't been backed up yet.*backupCustomerSheetNow/.test(issues()), issues());
  c.backupCustomerSheet_();
  check("after a backup: nothing to report", !/backed up/.test(issues()), issues());
  b.setNow("2026-10-10T05:00:00Z");
  check("still fine the next morning before it runs", !/backed up/.test(issues()), issues());
  b.setNow("2026-10-11T06:00:00Z");
  check("two days without one: flagged with the last date", /hasn't been backed up since Fri 9 Oct/.test(issues()), issues());
  const noSheet = loadBackend({ now: NOW });
  const t = noSheet.ctx.dailyHealthCheck_({ force: true }).issues.join(" | ");
  check("no customer sheet: only that is reported, not the backup too", /customer sheet can't be found/.test(t) && !/backed up/.test(t), t);

  const run = c.backupCustomerSheetNow();
  check("backupCustomerSheetNow makes one from the editor", run.ok === true && run.made === true && /Backups folder: /.test(b.logs.join("\n")));
  b.state.owner = "someone@else.com";
  let refused = false;
  try { c.backupCustomerSheetNow(); } catch (e) { refused = true; }
  check("and only for the owner", refused);
})();

// ================= Review links =================
(function reviews() {
  console.log("\n== Review requests: Google first, Trustpilot second (FRE-217)");
  const b = setup(); const c = b.ctx;
  const v = b.addBooking({ Reference: "EC-30001", "Payment method": "Cash", "Starts at": b.date("2026-10-09T08:00:00Z") }, "2026-10-09T08:00:00Z");
  c.adminCompleteJob(v["Job token"], SIGNATURE, "");
  const ty = b.sentTo("sam@example.com").filter((e) => /Thanks for booking/.test(e.subject))[0];
  check("thank-you email sent", !!ty);
  const g = ty.body.indexOf(GOOGLE), t = ty.body.indexOf(TRUSTPILOT);
  check("plain text: Google link, then Trustpilot", g !== -1 && t !== -1 && g < t, ty.body);
  check("plain text asks for a Google review", /a Google review really helps/.test(ty.body));
  check("HTML: the button goes to Google", /<a href="https:\/\/g\.page\/r\/CUP3ss-4Yk11EBM\/review"[^>]*>Leave us a Google review<\/a>/.test(ty.html));
  check("HTML: Trustpilot offered underneath", ty.html.indexOf("Prefer Trustpilot?") > ty.html.indexOf("Leave us a Google review") && ty.html.indexOf('href="' + TRUSTPILOT + '"') !== -1);

  c.sendFollowUpEmail_(b.row("EC-30001"));
  const fu = b.sentTo("sam@example.com").filter((e) => /How's everything looking/.test(e.subject))[0];
  check("follow-up sent", !!fu);
  check("follow-up plain text: Google, then Trustpilot", fu.body.indexOf(GOOGLE) !== -1 && fu.body.indexOf(GOOGLE) < fu.body.indexOf("Or on Trustpilot: " + TRUSTPILOT), fu.body);
  check("follow-up button goes to Google", /<a href="https:\/\/g\.page\/r\/CUP3ss-4Yk11EBM\/review"[^>]*>Leave us a Google review<\/a>/.test(fu.html));
  check("follow-up offers Trustpilot under the button", fu.html.indexOf("Prefer Trustpilot?") > fu.html.indexOf("Leave us a Google review") && fu.html.indexOf(">Review us there</a>") !== -1);

  // Agents don't get asked for reviews.
  const a = setup(); const ac = a.ctx;
  const av = a.addBooking({ Reference: "EC-30002", Channel: "Agent/Landlord", "Business name": "Acme Lettings", Email: "agent@example.com",
    "Payment method": "Invoice, 14 days", "Starts at": a.date("2026-10-09T08:00:00Z") }, "2026-10-09T08:00:00Z");
  ac.adminCompleteJob(av["Job token"], SIGNATURE, "");
  ac.sendFollowUpEmail_(a.row("EC-30002"));
  const agentMail = a.sentTo("agent@example.com");
  check("agents get no review links at all", agentMail.length === 2 &&
    agentMail.every((m) => m.body.indexOf(GOOGLE) === -1 && m.body.indexOf(TRUSTPILOT) === -1 && (m.html || "").indexOf(GOOGLE) === -1 && (m.html || "").indexOf(TRUSTPILOT) === -1),
    agentMail.map((m) => m.subject));

  // Other emails using the simple layout are unchanged: no stray second link.
  const plainHtml = c.buildSimpleEmailHtml({ name: "Sam", heading: "Hi", body: "Text", button: { text: "Go", url: "https://example.com" } });
  check("a button with no second link shows just the button", plainHtml.indexOf("Prefer Trustpilot?") === -1 && plainHtml.indexOf(">Go</a>") !== -1);
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nAll passed.");
process.exit(failures ? 1 : 0);
