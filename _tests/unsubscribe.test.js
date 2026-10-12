/*
 * FRE-219: the one-click unsubscribe link for marketing emails
 * (unsubscribe.html?u=<token> on the website, POST { action: "unsubscribe" }).
 *
 * From the repo root:
 *   node _tests/unsubscribe.test.js
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

const NOW = "2026-10-12T13:00:00Z";
const MANAGE = "a".repeat(32);
function setup() {
  const b = loadBackend({ now: NOW });
  b.setUpSheet();
  // Sam: two bookings, opted in on the second, email typed differently.
  b.addBooking({ Reference: "EC-10001", Email: "Sam@Example.com", Timestamp: b.date("2026-09-01T09:00:00Z"), "Marketing opt-in": "No" });
  b.addBooking({ Reference: "EC-10002", Email: "sam@example.com ", Timestamp: b.date("2026-10-01T09:00:00Z"), "Marketing opt-in": "Yes",
    "Marketing consent": "Ticked \"Keep me posted about seasonal offers and cleaning reminders\" when booking online, 1 October 2026", "Manage token": MANAGE });
  // Jo: opted in, a different person.
  b.addBooking({ Reference: "EC-10003", Email: "jo@example.com", Name: "Jo Other", Timestamp: b.date("2026-10-02T09:00:00Z"), "Marketing opt-in": "Yes" });
  // No email at all.
  b.addBooking({ Reference: "EC-10004", Email: "", Timestamp: b.date("2026-10-03T09:00:00Z") });
  return b;
}
const tokenOf = (link) => (/\?u=([0-9a-f]{32})$/.exec(link) || [])[1];
const post = (c, body) => JSON.parse(c.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const listEmails = (b) => {
  const tab = b.ctx.SpreadsheetApp.openById(b.state.props.customerSheetId).getSheetByName("Marketing list");
  return tab.rows.slice(1).map((r) => r[0]);
};

(function link() {
  console.log("\n== Each person's link");
  const b = setup(); const c = b.ctx;
  const l = c.unsubscribeLinkFor_("sam@example.com");
  check("a link to unsubscribe.html with a random token", /^https:\/\/easycleansomerset\.co\.uk\/unsubscribe\.html\?u=[0-9a-f]{32}$/.test(l), l);
  check("saved on every booking with that email, however it was typed", b.row("EC-10001")["Unsubscribe token"] === tokenOf(l) && b.row("EC-10002")["Unsubscribe token"] === tokenOf(l));
  check("not on anyone else's", !b.row("EC-10003")["Unsubscribe token"]);
  check("the same link every time", c.unsubscribeLinkFor_(" SAM@example.com") === l);
  check("a different person gets a different one", tokenOf(c.unsubscribeLinkFor_("jo@example.com")) !== tokenOf(l));
  check("a later booking from them gets the same token", (() => {
    b.addBooking({ Reference: "EC-10005", Email: "sam@example.com", Timestamp: b.date("2026-10-10T09:00:00Z") });
    c.unsubscribeLinkFor_("sam@example.com");
    return b.row("EC-10005")["Unsubscribe token"] === tokenOf(l);
  })());
  check("no email, no link", c.unsubscribeLinkFor_("") === "");

  const f = c.marketingFooter_("sam@example.com");
  check("footer text has the link and reply STOP", f.text.indexOf(l) !== -1 && /reply STOP/.test(f.text) && /Booking emails aren't affected/.test(f.text));
  check("footer HTML has an Unsubscribe link", f.html.indexOf('href="' + l + '"') !== -1 && />Unsubscribe<\/a>/.test(f.html));
  let threw = false;
  try { c.marketingFooter_(""); } catch (e) { threw = true; }
  check("no footer without an email, so nothing marketing can go out without one", threw);

  c.refreshMarketingList();
  const tab = c.SpreadsheetApp.openById(b.state.props.customerSheetId).getSheetByName("Marketing list");
  const col = tab.rows[0].indexOf("Unsubscribe link");
  check("the Marketing list tab has each person's link", col !== -1 && tab.rows.slice(1).every((r) => /unsubscribe\.html\?u=[0-9a-f]{32}$/.test(r[col])));
  check("Sam's link on the list is the same one", tab.rows.slice(1).some((r) => r[0] === "sam@example.com" && r[col] === l));
})();

(function unsubscribing() {
  console.log("\n== Using the link");
  const b = setup(); const c = b.ctx;
  const u = tokenOf(c.unsubscribeLinkFor_("sam@example.com"));
  c.unsubscribeLinkFor_("jo@example.com");

  let r = post(c, { action: "unsubscribe", u });
  check("works through doPost", r.ok === true && r.already === false, r);
  check("Unsubscribed on set on every booking with that email", ["EC-10001", "EC-10002"].every((ref) => b.row(ref)["Unsubscribed on"] instanceof c.Date));
  check("nobody else touched", !b.row("EC-10003")["Unsubscribed on"]);
  c.refreshMarketingList();
  check("off the marketing list", listEmails(b).join() === "jo@example.com", listEmails(b));
  const note = b.sentTo("owner@example.com").filter((m) => /Unsubscribed: /.test(m.subject))[0];
  check("Niall is told", note && /used the unsubscribe link/.test(note.body));
  check("the customer isn't emailed", b.sentTo("sam@example.com").length === 0 && b.sentTo("Sam@Example.com").length === 0);
  check("the booking itself is untouched", !b.row("EC-10002")["Cancelled at"] && b.row("EC-10002")["Manage token"] === MANAGE);

  const first = b.row("EC-10002")["Unsubscribed on"].getTime();
  b.advanceMinutes(60);
  const ownerBefore = b.sentTo("owner@example.com").length;
  r = post(c, { action: "unsubscribe", u });
  check("clicking again: already, nothing changes", r.ok === true && r.already === true && b.row("EC-10002")["Unsubscribed on"].getTime() === first);
  check("and no second email to Niall", b.sentTo("owner@example.com").length === ownerBefore);

  // Ticking the box again on a later booking is fresh consent; the same link works again.
  b.advanceMinutes(60);
  b.addBooking({ Reference: "EC-10006", Email: "sam@example.com", Timestamp: new c.Date(), "Marketing opt-in": "Yes", "Marketing consent": "Ticked again" });
  check("back on the list after opting in again", c.refreshMarketingList() === 2);
  r = post(c, { action: "unsubscribe", u });
  check("the same link takes them off again", r.ok === true && r.already === false && c.refreshMarketingList() === 1);
})();

(function safety() {
  console.log("\n== Only does that one thing");
  const b = setup(); const c = b.ctx;
  const u = tokenOf(c.unsubscribeLinkFor_("sam@example.com"));
  check("junk token: not_found", post(c, { action: "unsubscribe", u: "<script>" }).error === "not_found" && post(c, { action: "unsubscribe" }).error === "not_found");
  check("unknown token: not_found", post(c, { action: "unsubscribe", u: "f".repeat(32) }).error === "not_found");
  check("a manage token can't unsubscribe", post(c, { action: "unsubscribe", u: MANAGE }).error === "not_found");
  check("a job token can't unsubscribe", post(c, { action: "unsubscribe", u: b.row("EC-10002")["Job token"] }).error === "not_found");
  check("the unsubscribe token can't open the change page", c.getPublicBooking(u).ok === false);
  check("or the sign-off page", c.getPublicJob(u).ok === false);
  check("or cancel a booking", c.cancelBookingPublic({ t: u, reason: "Other" }).ok === false && !b.row("EC-10002")["Cancelled at"]);
  check("the reply never includes the email address", JSON.stringify(post(c, { action: "unsubscribe", u })).indexOf("example.com") === -1);

  // Someone who never ticked the box can still use a link they were sent.
  const n = setup();
  const nu = tokenOf(n.ctx.unsubscribeLinkFor_("sam@example.com"));
  n.ctx.setUnsubscribedFor_("sam@example.com", "");
  const before = n.ctx.marketingPeople_(n.sheet())["sam@example.com"].subscribed;
  check("someone on the list unsubscribes", before === true && post(n.ctx, { action: "unsubscribe", u: nu }).already === false);
  const never = setup();
  never.addBooking({ Reference: "EC-20001", Email: "never@example.com", Timestamp: never.date("2026-10-04T09:00:00Z"), "Marketing opt-in": "No" });
  const vu = tokenOf(never.ctx.unsubscribeLinkFor_("never@example.com"));
  const vr = post(never.ctx, { action: "unsubscribe", u: vu });
  check("someone who never opted in: recorded anyway", vr.ok === true && never.row("EC-20001")["Unsubscribed on"] instanceof never.ctx.Date);
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nAll passed.");
process.exit(failures ? 1 : 0);
