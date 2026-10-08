/*
 * FRE-212: the model cancellation form goes out as a PDF attached to a
 * homeowner's confirmation email, not as a box in the email itself.
 *
 * From the repo root:
 *   node _tests/cancellation-form.test.js
 *
 * Runs Code.gs with Google's services faked (see fake-google.js). Needs no
 * npm install. The fake's "PDF" is the HTML the real one would be made
 * from, so this checks what goes into the PDF, not how it looks.
 */
const { loadBackend } = require("./fake-google");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || detail === undefined ? "" : "  (" + JSON.stringify(detail) + ")"));
  if (!ok) failures++;
}

function homeowner(extra) {
  return Object.assign({
    name: "Sam Customer", email: "sam@example.com", phone: "07000 000001",
    address: "1 High Street, Midsomer Norton", postcode: "ba3 2aa",
    items: "2× Medium room: £90", total: "£90", payment: "Cash", channel: "Consumer",
    notes: "Side gate is open",
  }, extra || {});
}

function agent() {
  return {
    name: "Pat Agent", email: "pat@acme.example", phone: "07000 000002",
    address: "5 Mill Lane, BA3 4BB", items: "3× Medium room: £135", total: "£135",
    payment: "Invoice, 14 days", channel: "Agent/Landlord", businessName: "Acme Lettings",
    accessArrange: true, notes: "Keys at the office",
  };
}

const SLOT = "Wed 14 Oct, 10:00am";

// ================= Homeowner: PDF attached =================
(function attached() {
  console.log("\n== Homeowner confirmation: form as a PDF (FRE-212)");
  const b = loadBackend({ now: "2026-10-08T09:00:00Z" });
  const c = b.ctx;
  const data = homeowner({ earlyStart: true });
  data.cancellation = c.cancellationInfo_(data, b.date("2026-10-14T09:00:00Z"), b.date("2026-10-08T09:00:00Z"));
  c.sendBookingConfirmation_(data, "EC-10042", SLOT);

  const mail = b.sentTo("sam@example.com")[0];
  check("one email sent to the customer", b.sentTo("sam@example.com").length === 1);
  check("it has exactly one attachment", mail.attachments.length === 1, mail.attachments.length);
  const pdf = mail.attachments[0];
  check("the attachment is a PDF", pdf.getContentType() === "application/pdf", pdf.getContentType());
  check("named with the reference", pdf.getName() === "EasyClean-Somerset-cancellation-form-EC-10042.pdf", pdf.getName());

  // What the PDF is made from
  const p = pdf.html;
  check("PDF has the model form wording", p.indexOf("I/We hereby give notice that I/We cancel my/our contract for the supply of the following service") !== -1);
  check("PDF has the trader name, address and email",
    p.indexOf(c.BUSINESS_NAME + " trading as EasyClean Somerset, " + c.BUSINESS_ADDRESS + ". Email: " + c.TRADER_EMAIL) !== -1);
  check("PDF has the booking reference", p.indexOf("Cleaning, booking reference EC-10042") !== -1);
  check("PDF has the date they booked", p.indexOf("8 October 2026") !== -1);
  check("PDF has the deadline", p.indexOf("Thursday 22 October 2026") !== -1);
  check("PDF has their name", p.indexOf("Sam Customer") !== -1);
  check("PDF adds the postcode to the address, in capitals", p.indexOf("1 High Street, Midsomer Norton, BA3 2AA") !== -1);
  check("PDF leaves signature and date blank", /Signature of consumer\(s\)[^<]*<\/td><td class="val tall">&nbsp;/.test(p) && /Date<\/td><td class="val tall">&nbsp;/.test(p));
  check("PDF says to only send it to cancel", p.indexOf("Only fill in and send this form if you want to cancel.") !== -1);

  // The email itself
  const h = mail.html;
  check("email says the form is attached", h.indexOf("use the cancellation form attached.") !== -1);
  check("email still gives the deadline", h.indexOf("Thursday 22 October 2026") !== -1);
  check("email still links to section 11 of the terms", h.indexOf("/terms.html#cancel") !== -1);
  check("email keeps the early-start sentence", h.indexOf("You asked us to do your clean within those 14 days.") !== -1);
  check("email has no form box", h.indexOf("Cancellation form") === -1 && h.indexOf("I/We hereby give notice") === -1 && h.indexOf("border:1px dashed") === -1);
  check("email keeps the trader details", h.indexOf("trading as EasyClean Somerset") !== -1);

  const t = mail.body;
  check("plain text says the form is attached", t.indexOf("use the cancellation form attached.") !== -1);
  check("plain text has no form", t.indexOf("CANCELLATION FORM") === -1 && t.indexOf("I/We hereby give notice") === -1);
  check("plain text keeps the deadline and terms link", t.indexOf("so until Thursday 22 October 2026") !== -1 && t.indexOf("/terms.html#cancel") !== -1);
  check("plain text keeps the trader details", t.indexOf("Business details:") !== -1);
  check("nothing went in the problem log", !b.state.props.PROBLEM_LOG || b.state.props.PROBLEM_LOG === "[]", b.state.props.PROBLEM_LOG);
})();

// ================= Homeowner: no early start =================
(function noEarlyStart() {
  console.log("\n== Homeowner, clean after the 14 days");
  const b = loadBackend({ now: "2026-10-08T09:00:00Z" });
  const c = b.ctx;
  const data = homeowner({ postcode: "", address: "1 High Street, BA3 2AA" });
  data.cancellation = c.cancellationInfo_(data, b.date("2026-10-27T09:00:00Z"), b.date("2026-10-08T09:00:00Z"));
  c.sendBookingConfirmation_(data, "EC-10043", "Tue 27 Oct, 10:00am");
  const mail = b.sentTo("sam@example.com")[0];
  check("PDF attached", mail.attachments.length === 1);
  check("no early-start sentence", mail.html.indexOf("You asked us to do your clean within those 14 days.") === -1);
  check("address already holding the postcode isn't doubled", mail.attachments[0].html.indexOf("1 High Street, BA3 2AA</td>") !== -1);
})();

// ================= Admin-app booking (no start time given) =================
(function adminBooking() {
  console.log("\n== Homeowner booked in the admin app");
  const b = loadBackend({ now: "2026-10-08T09:00:00Z" });
  const c = b.ctx;
  c.sendBookingConfirmation_(homeowner(), "EC-10044", SLOT); // no data.cancellation: worked out here
  const mail = b.sentTo("sam@example.com")[0];
  check("still gets the PDF", mail.attachments.length === 1 && /cancellation-form-EC-10044\.pdf$/.test(mail.attachments[0].getName()));
})();

// ================= Agent: unchanged =================
(function agentEmail() {
  console.log("\n== Agent confirmation: unchanged");
  const b = loadBackend({ now: "2026-10-08T09:00:00Z" });
  const c = b.ctx;
  c.sendBookingConfirmation_(agent(), "EC-20042", SLOT);
  const mail = b.sentTo("pat@acme.example")[0];
  check("no attachment", mail.attachments.length === 0, mail.attachments.length);
  check("no right-to-cancel section", mail.html.indexOf("Your right to cancel") === -1 && mail.body.indexOf("YOUR RIGHT TO CANCEL") === -1);
  check("no form", mail.html.indexOf("Cancellation form") === -1);
})();

// ================= PDF fails: form goes in the email =================
(function fallback() {
  console.log("\n== The PDF can't be made");
  const b = loadBackend({ now: "2026-10-08T09:00:00Z" });
  const c = b.ctx;
  const realCreate = c.HtmlService.createHtmlOutput;
  c.HtmlService.createHtmlOutput = (html) => {
    const out = realCreate(html);
    if (html.indexOf("<h1>Cancellation form</h1>") !== -1) out.getAs = () => { throw new Error("PDF service unavailable"); };
    return out;
  };
  const data = homeowner();
  data.cancellation = c.cancellationInfo_(data, b.date("2026-10-14T09:00:00Z"), b.date("2026-10-08T09:00:00Z"));
  c.sendBookingConfirmation_(data, "EC-10045", SLOT);
  c.HtmlService.createHtmlOutput = realCreate;

  const mail = b.sentTo("sam@example.com")[0];
  check("the email still goes", !!mail);
  check("no attachment", mail.attachments.length === 0);
  check("email has the form box instead", mail.html.indexOf("Cancellation form") !== -1 && mail.html.indexOf("I/We hereby give notice") !== -1);
  check("email says use the form below", mail.html.indexOf("use the form below.") !== -1);
  check("plain text has the form", mail.body.indexOf("CANCELLATION FORM") !== -1 && mail.body.indexOf("booking reference EC-10045") !== -1);
  const log = JSON.parse(b.state.props.PROBLEM_LOG || "[]");
  check("the problem log notes it", log.length === 1 && log[0].where.indexOf("EC-10045") !== -1 && log[0].msg === "PDF service unavailable", log);
})();

// ================= Escaping =================
(function escaping() {
  console.log("\n== Names and addresses are escaped in the PDF");
  const b = loadBackend({ now: "2026-10-08T09:00:00Z" });
  const c = b.ctx;
  const data = homeowner({ name: "Jo <b>O'Neil</b>", address: "Flat 2 & 3, <i>High St</i>" });
  c.sendBookingConfirmation_(data, "EC-10046", SLOT);
  const p = b.sentTo("sam@example.com")[0].attachments[0].html;
  check("no raw tags from the customer", p.indexOf("<b>O") === -1 && p.indexOf("<i>High") === -1);
  check("escaped text is there", p.indexOf("Jo &lt;b&gt;O&#39;Neil&lt;/b&gt;") !== -1 && p.indexOf("Flat 2 &amp; 3") !== -1);
})();

// ================= Sample email for Niall =================
(function sample() {
  console.log("\n== sendTestConfirmationEmail");
  const b = loadBackend({ now: "2026-10-08T09:00:00Z" });
  const c = b.ctx;
  const sheetsBefore = Object.keys(b.state.spreadsheets).length;
  c.sendTestConfirmationEmail();
  const mail = b.sentTo("owner@example.com")[0];
  check("goes to the script owner", !!mail && b.state.emails.length === 1);
  check("has the PDF attached", mail && mail.attachments.length === 1 && /cancellation-form-EC-TEST\.pdf$/.test(mail.attachments[0].getName()));
  check("books nothing", b.state.events.length === 0 && Object.keys(b.state.spreadsheets).length === sheetsBefore);
})();

console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
process.exit(failures ? 1 : 0);
