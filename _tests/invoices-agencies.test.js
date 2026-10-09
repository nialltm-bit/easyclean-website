/*
 * FRE-195 and FRE-203: late-payment wording on agent invoices, matching
 * agency names in the Agencies tab, and the real job date on jobs signed off
 * on a later day.
 *
 * From the repo root:
 *   node _tests/invoices-agencies.test.js
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

const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// Thu 8 Oct 2026, 10:00am UK time.
const NOW = "2026-10-08T09:00:00Z";

function setup(now) {
  const b = loadBackend({ now: now || NOW });
  b.setUpSheet();
  return b;
}
function agent(b, extra, startIso) {
  return b.addBooking(Object.assign({
    Reference: "EC-20001", Name: "Pat Agent", Email: "pat@acme.example", "Business name": "Acme Lettings", Channel: "Agent/Landlord",
    "Payment method": "Invoice, 14 days", "Site contact name": "Sam Tenant", "Site contact phone": "07000 000002",
    Total: "£300", Items: "3× Medium room: £135",
  }, extra || {}), startIso === undefined ? "2026-10-08T08:00:00Z" : startIso);
}
const attachment = (b, re) => {
  for (const e of b.state.emails) for (const a of e.attachments || []) if (re.test(a.getName())) return a.html;
  return null;
};
const invoiceHtml = (b) => attachment(b, /^INV-/);
const completionHtml = (b) => attachment(b, /^Job-completion-/);
const agenciesTab = (b) => b.ctx.SpreadsheetApp.openById(b.state.props.CUSTOMER_SHEET_ID || Object.keys(b.state.spreadsheets)[0]).getSheetByName("Agencies");
function addAgency(b, row) {
  b.ctx.findOrAddAgency_("Placeholder so the tab exists");
  const tab = agenciesTab(b);
  const header = tab.rows[0];
  // Drop the placeholder row.
  tab.rows = tab.rows.filter((r) => r[header.indexOf("Business name")] !== "Placeholder so the tab exists");
  tab.rows.push(header.map((h) => (h in row ? row[h] : "")));
}
const agencyRows = (b) => {
  const tab = agenciesTab(b);
  const h = tab.rows[0];
  return tab.rows.slice(1).map((r) => r[h.indexOf("Business name")]);
};

// ================= Late-payment line =================
(function latePayment() {
  console.log("\n== Late-payment line on agent invoices (FRE-195)");
  let b = setup(); let c = b.ctx;
  check("compensation by size of debt", c.lateFeeCompensation_(300) === 40 && c.lateFeeCompensation_(999.99) === 40 &&
    c.lateFeeCompensation_(1000) === 70 && c.lateFeeCompensation_(9999.99) === 70 && c.lateFeeCompensation_(10000) === 100);
  const v = agent(b);
  check("agent sign-off works", c.adminCompleteJob(v["Job token"], "", "keys left").ok === true);
  let html = invoiceHtml(b);
  check("the agent invoice has the late-payment line", html && html.indexOf("If this invoice isn&#39;t paid by the due date, we may charge statutory interest at 8% above the Bank of England base rate, plus £40 fixed compensation, under the Late Payment of Commercial Debts (Interest) Act 1998.") !== -1,
    html && html.slice(html.indexOf("Late") - 200, html.indexOf("Late") + 200));

  b = setup(); c = b.ctx;
  const big = agent(b, { Total: "£1,200", Items: "1× Whole house: £1,200" });
  c.adminCompleteJob(big["Job token"], "", "keys left");
  check("£70 on an invoice of £1,000 or more", /plus £70 fixed compensation/.test(invoiceHtml(b)));

  b = setup(); c = b.ctx;
  const cash = agent(b, { "Payment method": "Cash" });
  c.adminCompleteJob(cash["Job token"], "", "paid on the day");
  check("an agent who paid cash gets no late-payment line", !/Late Payment of Commercial Debts/.test(invoiceHtml(b)));

  b = setup(); c = b.ctx;
  const home = b.addBooking({ Reference: "EC-10001", "Payment method": "Bank transfer" }, "2026-10-08T08:00:00Z");
  c.adminCompleteJob(home["Job token"], "", "paid on the day");
  check("a homeowner invoice never has it (consumers aren't covered)", invoiceHtml(b) && !/Late Payment of Commercial Debts/.test(invoiceHtml(b)));

  b = setup(); c = b.ctx;
  const fee = agent(b, {}, "2026-10-08T20:00:00Z"); // 10 hours away: a late cancellation
  const r = c.adminCancelJob(fee["Job token"], { reason: "customer", chargeFee: true, emailCustomer: true });
  check("an agent's cancellation fee invoice has it too", r.ok && /plus £40 fixed compensation/.test(invoiceHtml(b) || ""), r);
})();

// ================= Agency names =================
(function agencyNames() {
  console.log("\n== Agency names (FRE-195)");
  const b = setup(); const c = b.ctx;
  check("same name ignoring capitals, spaces, punctuation, & and Ltd",
    c.agencyKey_("The Andrews & Co. Ltd") === c.agencyKey_("andrews and co") && c.agencyKey_("Cooper & Tanner") === c.agencyKey_("Cooper and Tanner") &&
    c.agencyKey_("  ANDREWS  ") === c.agencyKey_("Andrews") && c.agencyKey_("Andrews Limited") === c.agencyKey_("Andrews"));
  check("but not merging different words", c.agencyKey_("Andrews Property") !== c.agencyKey_("Andrews") && c.agencyKey_("Bath Lettings") !== c.agencyKey_("Bath Property"));
  check("the distinctive part of a name", c.agencyCore_("Andrews Property Lettings Ltd") === "andrews" && c.agencyCore_("Cooper & Tanner Estate Agents") === "cooper tanner");

  addAgency(b, { "Business name": "Andrews", "Billing address": "1 Office Row, Bath BA1 1AA", "Accounts email": "accounts@andrews.example" });
  let a = c.getAgencyBilling("ANDREWS LTD");
  check("an exact-but-for-case match uses the agency's details", a.businessName === "Andrews" && a.billingAddress === "1 Office Row, Bath BA1 1AA" && a.accountsEmail === "accounts@andrews.example", a);
  check("and adds no new row", agencyRows(b).join("|") === "Andrews", agencyRows(b));

  let f = c.findOrAddAgency_("Andrews Property");
  check("a look-alike name is added, not merged", f.added === true && f.billingAddress === "" && agencyRows(b).join("|") === "Andrews|Andrews Property", [f, agencyRows(b)]);
  check("and is reported as looking like the other", f.looksLike.join() === "Andrews", f.looksLike);
  const note = c.agencyAlertText_("Andrews Property", f);
  check("the new-booking note says what to do", note === "\"Andrews Property\" is new in the Agencies tab, but looks like \"Andrews\". If it's the same agency, type Andrews in its Same as column, so the invoice uses Andrews's billing address.", note);

  // Niall types "Andrews" in its Same as column.
  const tab = agenciesTab(b);
  const h = tab.rows[0];
  check("the tab has a Same as column", h.indexOf("Same as") !== -1, h);
  tab.rows[2][h.indexOf("Same as")] = "andrews";
  a = c.getAgencyBilling("Andrews Property");
  check("Same as uses the other row's name, address and accounts email", a.businessName === "Andrews" && a.billingAddress === "1 Office Row, Bath BA1 1AA" && a.accountsEmail === "accounts@andrews.example", a);
  f = c.findOrAddAgency_("Andrews Property");
  check("and it's no longer flagged", f.added === false && c.agencyAlertText_("Andrews Property", f) === "", f);

  f = c.findOrAddAgency_("Hunters");
  check("a brand-new agency is added and flagged for its billing address", f.added && !f.looksLike.length &&
    c.agencyAlertText_("Hunters", f) === "\"Hunters\" is a new agency. Add its billing address in the Agencies tab before the job, so the invoice has it.");
  f = c.findOrAddAgency_("hunters");
  check("next time: still no billing address, so still flagged", !f.added && /There's no billing address for "Hunters"/.test(c.agencyAlertText_("hunters", f)));
  check("a look-alike never points at a Same as row", c.findOrAddAgency_("Andrews Lettings").looksLike.join() === "Andrews");

  // A Same as loop can't hang it.
  addAgency(b, { "Business name": "Loop A", "Same as": "Loop B" });
  addAgency(b, { "Business name": "Loop B", "Same as": "Loop A" });
  check("a Same as loop stops", typeof c.getAgencyBilling("Loop A").businessName === "string");
  addAgency(b, { "Business name": "Ghost Homes", "Billing address": "2 Ghost Rd", "Same as": "Nobody Here" });
  const g = c.getAgencyBilling("Ghost Homes");
  check("a Same as that names nothing uses its own row", g.businessName === "Ghost Homes" && g.billingAddress === "2 Ghost Rd", g);

  // The invoice uses the Same as row.
  const b2 = setup(); const c2 = b2.ctx;
  addAgency(b2, { "Business name": "Andrews", "Billing address": "1 Office Row, Bath BA1 1AA", "Accounts email": "accounts@andrews.example" });
  addAgency(b2, { "Business name": "Andrews Property", "Same as": "Andrews" });
  const v = agent(b2, { "Business name": "Andrews Property" });
  c2.adminCompleteJob(v["Job token"], "", "keys left");
  const html = invoiceHtml(b2);
  check("the invoice is billed to the Same as agency, at its address", html && html.indexOf(">Andrews<") !== -1 && html.indexOf("1 Office Row, Bath BA1 1AA") !== -1);
  const invMail = b2.state.emails.filter((e) => /^Invoice/.test(e.subject))[0];
  check("and goes to its accounts email too", invMail && (invMail.to === "accounts@andrews.example" || String(invMail.opts.cc || "").indexOf("accounts@andrews.example") !== -1), invMail && [invMail.to, invMail.opts.cc]);

  // The check settings list skips Same as rows.
  c2.checkInvoiceSettings();
  check("checkInvoiceSettings doesn't list a Same as row as missing an address", !b2.logs.some((l) => /missing a billing address: .*Andrews Property/.test(l)), b2.logs);
})();

// ================= Agency check at booking =================
(function atBooking() {
  console.log("\n== The agency is checked when an agent books");
  const b = setup(); const c = b.ctx;
  addAgency(b, { "Business name": "Andrews", "Billing address": "1 Office Row, Bath BA1 1AA" });
  const slot = c.getAvailableSlots()[5];
  const r = c.createBooking({
    startTime: slot.start, name: "Pat Agent", phone: "07000 000001", email: "pat@andrews.example", address: "9 Flat Lane", postcode: "BA3 2AA",
    items: "1× Medium room: £45", total: "£45", estTime: "~1h 25m", payment: "Invoice, 14 days", channel: "Agent/Landlord",
    businessName: "Andrews Property", siteContactName: "Sam Tenant", siteContactPhone: "07000 000002", slotLabel: "x",
    lineItems: [{ item: "Medium room", qty: 1 }],
  });
  check("agent booking made", r.ok === true, r);
  check("the agency is added to the tab straight away", agencyRows(b).indexOf("Andrews Property") !== -1, agencyRows(b));
  const alert = b.state.emails.filter((e) => /New booking/.test(e.subject))[0];
  check("your new-booking email flags the look-alike", alert && alert.body.indexOf("NOTE: \"Andrews Property\" is new in the Agencies tab, but looks like \"Andrews\".") !== -1, alert && alert.body);

  const r2 = c.createBooking({
    startTime: c.getAvailableSlots()[9].start, name: "Pat Agent", phone: "07000 000001", email: "pat@andrews.example", address: "9 Flat Lane", postcode: "BA3 2AA",
    items: "1× Medium room: £45", total: "£45", estTime: "~1h 25m", payment: "Invoice, 14 days", channel: "Agent/Landlord",
    businessName: "andrews", siteContactName: "Sam Tenant", siteContactPhone: "07000 000002", slotLabel: "x",
    lineItems: [{ item: "Medium room", qty: 1 }],
  });
  const alerts = b.state.emails.filter((e) => /New booking/.test(e.subject));
  check("an agency with a billing address gets no note", r2.ok && alerts.length === 2 && alerts[1].body.indexOf("Agencies tab") === -1, alerts.length && alerts[alerts.length - 1].body);

  const home = c.createBooking({
    startTime: c.getAvailableSlots()[14].start, name: "Sam Home", phone: "07000 000003", email: "sam@example.com", address: "1 High St", postcode: "BA3 2AA",
    items: "1× Medium room: £45", total: "£45", estTime: "~1h 25m", payment: "Cash", channel: "Consumer", slotLabel: "x",
    lineItems: [{ item: "Medium room", qty: 1 }], earlyStart: true,
  });
  check("homeowner bookings don't touch the Agencies tab", home.ok && agencyRows(b).indexOf("Sam Home") === -1);
})();

// ================= Signed off on a later day =================
(function signedLater() {
  console.log("\n== Job signed off on a later day (FRE-203)");
  // The clean was Mon 5 Oct at 9am; the customer signs the link on Thu 8 Oct.
  let b = setup(); let c = b.ctx;
  let v = b.addBooking({ Reference: "EC-10001", "Payment method": "Cash", "Starts at": b.date("2026-10-05T08:00:00Z") }, "2026-10-05T08:00:00Z");
  check("signed off", c.adminCompleteJob(v["Job token"], SIGNATURE, "").ok === true);
  let html = invoiceHtml(b);
  check("invoice date is the day it's issued", html.indexOf("Invoice date 8 October 2026") !== -1);
  check("with the job date shown as well", html.indexOf("Job date 5 October 2026") !== -1);
  check("cash was paid on the day of the clean", html.indexOf("Paid by Cash on 5 October 2026.") !== -1, html.slice(html.indexOf("Paid by"), html.indexOf("Paid by") + 60));
  const comp = completionHtml(b);
  check("the completion PDF says when the work was done, and when it was signed", comp && comp.indexOf("Completed 5 October 2026") !== -1 && comp.indexOf("Signed 8 October 2026") !== -1);
  check("Paid on in the sheet is the day of the clean", b.row("EC-10001")["Paid on"].toISOString() === "2026-10-05T08:00:00.000Z", b.row("EC-10001")["Paid on"]);
  check("Completed at stays the sign-off time", b.row("EC-10001")["Completed at"].toISOString() === "2026-10-08T09:00:00.000Z");

  // The 2-day follow-up names the day of the clean.
  c.sendFollowUpEmail_(b.row("EC-10001"));
  const fu = b.sentTo("sam@example.com").filter((e) => /How's everything looking/.test(e.subject))[0];
  check("the follow-up says the clean was on Monday 5 October", fu && fu.body.indexOf("after we cleaned for you on Monday 5 October") !== -1, fu && fu.body);
  check("and the re-clean deadline still runs from sign-off", fu && fu.body.indexOf("tell us by Thursday 15 October") !== -1);

  // Timer started: that's the job date, even with no calendar event.
  b = setup(); c = b.ctx;
  v = b.addBooking({ Reference: "EC-10002", "Payment method": "Cash", "Started at": b.date("2026-10-06T07:40:00Z") });
  c.adminCompleteJob(v["Job token"], "", "signed later");
  check("the timer's start date counts first", /Job date 6 October 2026/.test(invoiceHtml(b)));

  // Same day: no extra line.
  b = setup(); c = b.ctx;
  v = b.addBooking({ Reference: "EC-10003", "Payment method": "Cash" }, "2026-10-08T07:00:00Z");
  c.adminCompleteJob(v["Job token"], SIGNATURE, "");
  html = invoiceHtml(b);
  check("signed the same day: no Job date line", html.indexOf("Job date") === -1 && html.indexOf("Paid by Cash on 8 October 2026.") !== -1);
  check("and the completion PDF has no Signed line", completionHtml(b).indexOf(">Signed ") === -1 && completionHtml(b).indexOf("Completed 8 October 2026") !== -1);

  // Signed off before the booked time: today, never a future date.
  b = setup(); c = b.ctx;
  v = b.addBooking({ Reference: "EC-10004", "Payment method": "Cash" }, "2026-10-12T08:00:00Z");
  c.adminCompleteJob(v["Job token"], "", "done early");
  check("a booking signed off before its time uses today", invoiceHtml(b).indexOf("Job date") === -1 && b.row("EC-10004")["Paid on"].toISOString() === "2026-10-08T09:00:00.000Z");

  // Agent invoice: still due 14 days from the invoice date.
  b = setup(); c = b.ctx;
  v = agent(b, {}, "2026-10-05T08:00:00Z");
  c.adminCompleteJob(v["Job token"], "", "keys left");
  html = invoiceHtml(b);
  check("an agent invoice signed later is due 14 days from the invoice date", html.indexOf("Due 22 October 2026") !== -1 && html.indexOf("Job date 5 October 2026") !== -1);
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
process.exit(failures ? 1 : 0);
