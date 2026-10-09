/**
 * EasyClean Somerset — booking backend (Google Apps Script Web App)
 *
 * What this does: replaces the old Google Calendar "Appointment Schedule"
 * widget. It runs inside Niall's own Google account (no third party sees
 * this code or this data) and does two jobs for the website:
 *
 *   1. GET  ?action=slots   -> which times are actually free, checked
 *                              live against this Google account's
 *                              default calendar.
 *   2. POST { action: "book", ... } -> creates the calendar event
 *                              directly, with the customer's item list,
 *                              estimated job time, price, address, phone
 *                              and payment method written straight into
 *                              the event, emails
 *                              the customer a confirmation, and records
 *                              the booking as a row in a Google Sheet
 *                              (see setUpCustomerSheet() below) so past
 *                              customers can actually be searched and
 *                              filtered, not just found by scrolling
 *                              through calendar events.
 *   3. A daily trigger (sendDayOfReminders, see setUpDailyReminders()
 *                              below) emails every customer booked in for
 *                              that day a morning-of reminder.
 *   4. GET  ?action=job&t=  -> looks a booking up by its secret job token
 *                              (used by job-complete.html, the page a
 *                              customer signs from) and returns the basics.
 *   5. POST { action: "complete", token, signature } -> records a
 *                              customer's signature (from job-complete.html),
 *                              marks it done in the customer sheet, saves
 *                              the invoice and signed completion PDFs to
 *                              Drive, and emails them out. Consumers get a
 *                              paid receipt + review request; agents paying
 *                              by bank transfer get a 14-day payment-due
 *                              invoice billed to their office address.
 *
 * SETUP (one-time):
 *   1. script.google.com -> New project -> paste this whole file in,
 *      replacing whatever's there by default.
 *   2. Check WEEKLY_SLOTS below matches your real availability. It's
 *      pre-filled to roughly match "Mon-Fri early & evening, Saturday
 *      full day, Sunday by arrangement" as already shown on the site.
 *   3. Project Settings (gear icon, left sidebar) -> General settings ->
 *      Time zone -> set to "(GMT+00:00) London". Important: if this is
 *      wrong, every slot time offered will be wrong too.
 *   4. Deploy -> New deployment -> type: Web app -> Execute as: Me ->
 *      Who has access: Anyone -> Deploy. Click "Authorize access" and
 *      allow it (it's asking to let this script see your calendar and
 *      send email from your own address — normal for this setup).
 *   5. Copy the Web app URL (ends in /exec) into APPS_SCRIPT_URL in the
 *      website's JS.
 *   6. One more one-time step so "Choose a time" loads instantly instead
 *      of waiting on a live calendar lookup: pick "setUpAutoRefresh" from
 *      the function dropdown next to the Run button (top toolbar) and
 *      click Run. See the comment directly above that function for what
 *      it does and why. Authorize it the same way as step 4 if asked.
 *   7. Same again for the customer database: pick "setUpCustomerSheet"
 *      from the same dropdown and click Run. Creates a new Google Sheet
 *      in your Drive and remembers it automatically — nothing to copy or
 *      paste. See the comment above that function for details.
 *   8. Same again for the morning reminder: pick "setUpDailyReminders"
 *      from the same dropdown and click Run. See the comment above that
 *      function for details.
 *   9. REVIEW_URL below is already set to the real Trustpilot review page —
 *      nothing to do here unless that link ever changes.
 *  10. Bank details for agent invoices: Project Settings -> Script
 *      Properties -> add BANK_ACCOUNT_NAME, BANK_SORT_CODE and
 *      BANK_ACCOUNT_NUMBER. Then pick "checkInvoiceSettings" from the
 *      function dropdown and Run it to confirm they're picked up.
 *  11. Agency billing addresses: fill in the "Agencies" tab of the
 *      customer sheet (created automatically the first time an agent job
 *      is completed, one row per agency).
 *  12. Private admin app (on-site sign-off, unpaid invoices, mark paid):
 *      see "ADMIN APP SETUP" near the bottom of this file. Needs the
 *      Dashboard.html file adding to this project and a second deployment.
 *  13. After pasting a version that adds a new Google permission (e.g.
 *      the price check's "connect to an external service"), run
 *      checkPriceList once from the function dropdown and allow it BEFORE
 *      redeploying, or live bookings fail until you do.
 *  14. Service area: the postcode districts we take online bookings in
 *      are listed in service-area.js on the website, not in this file.
 *      Edit that file on GitHub to change the area; bookings pick it up
 *      within the hour. checkPriceList also logs the list it reads.
 *  15. Day-before reminders and the Monday unpaid-invoice email run from
 *      the existing daily trigger (setUpDailyReminders); nothing to set up.
 *  16. Bank holidays close automatically (GOV.UK's list), and the admin
 *      app's "Time off" tab blocks other days or hours.
 *  17. Check Project Settings -> Time zone is Europe/London (slot times
 *      depend on it, especially when the clocks change).
 *  18. The monthly figures email goes out from the daily trigger on the 1st
 *      of each month. Run sendFiguresPreview any time to get last month's
 *      email now, and see the same numbers in the admin app's Figures tab.
 *  19. Run setUpManageTokens once (FRE-213): it gives every open booking a
 *      "Manage token", so its reminder emails get the Change or cancel
 *      button that opens my-booking.html on the website.
 *
 * IMPORTANT — updating this file later (every time, not just the first
 * time): pasting new code into the editor and saving it is NOT enough on
 * its own. The live Web App URL (the one ending in /exec, wired into the
 * website) is pinned to a specific deployed "version" of this script —
 * saving an edit updates what you see in the editor, but the live URL
 * keeps serving the OLD code until you explicitly push a new version to
 * it. After pasting any update and saving:
 *   1. Deploy (top-right) -> Manage deployments.
 *   2. Click the pencil/edit icon on the existing active deployment.
 *   3. Under "Version", choose "New version".
 *   4. Click Deploy.
 * This keeps the exact same /exec URL (nothing in the website's JS needs
 * to change) but makes it start running the code you just pasted. Skipping
 * this step is why a change can look "done" (saved, no errors) but the
 * live site keeps behaving like the old code was never updated.
 *
 * Running a function directly from the editor (via the function dropdown
 * + Run button, e.g. setUpAutoRefresh or setUpCustomerSheet) is different
 * and NOT affected by this — that always runs whatever is currently saved
 * in the editor, live deployment or not. That's one-time setup, though;
 * it doesn't make the deployed Web App itself pick up the new code.
 */

// ====== CONFIG — edit these to match your real setup ======
var SLOT_MINS = 150;       // must match SLOT_MINS in the website's JS
var LEAD_TIME_HOURS = 24;  // minimum notice before a booking can start
var DAYS_AHEAD = 21;       // how many days forward to offer slots (3 weeks)
var TIMEZONE = "Europe/London";
var WHATSAPP_NUMBER = "447873212249"; // must match WHATSAPP_NUMBER in the website's JS
var SITE_URL = "https://easycleansomerset.co.uk";
var BUSINESS_NAME = "Niall Maher";                 // real trading name, used on invoices — same one on terms.html
var BUSINESS_ADDRESS = "33 Ivy Walk, Midsomer Norton, BA3 2EE";
var REMINDER_HOUR = 7; // morning-of reminder emails go out in this hour, local time (TIMEZONE above)
var REVIEW_URL = "https://uk.trustpilot.com/review/easycleansomerset.co.uk";

// Every booking is also written as a row into a Google Sheet, alongside the
// calendar event createBooking() already creates. A calendar isn't built for
// searching or filtering; this is what actually lets you find a past
// customer, see what they've had done before, or pull a list for marketing.
// Run setUpCustomerSheet() ONCE (same way as setUpAutoRefresh below) and it
// creates the sheet and remembers its ID for you — nothing to copy or paste.
var CUSTOMER_SHEET_PROPERTY_KEY = "customerSheetId";
var CUSTOMER_SHEET_HEADERS = [
  "Timestamp", "Reference", "Name", "Phone", "Email", "Address",
  "Items", "Total", "Payment method", "Booking time", "Marketing opt-in",
  "Referral / offer code", "Channel", "Business name", "Site contact name",
  "Site contact phone", "Agent/Agency ID",
  // A long random secret per booking. The customer-facing signing link and
  // the private admin app identify a booking by this, never by the short
  // EC- reference, which is short enough to guess. Added to the live sheet
  // automatically (see appendCustomerRow) and backfilled for older rows.
  "Job token",
  // Agent bookings only: "Someone on site" or "Agent arranging (24h notice)".
  "Access",
  // Filled in later, by completeJob(), once the job's signed off on-site —
  // blank on every row from the moment it's booked until then.
  "Completed at", "Signature link", "Invoice number",
  "Invoice PDF", "Completion PDF", "Payment due", "Paid on"
];

// Every column completeJob() writes to. Unlike the booking-time columns
// above, these are added to the live sheet automatically (at the end of the
// header row) the first time a job is completed and any of them is missing,
// so there's no by-hand header step for this round. "Paid on" is the one
// column Niall fills in himself, when an agent's bank transfer lands; it's
// pre-filled for cash/on-the-day payments, which are paid at completion.
var COMPLETION_COLUMNS = [
  "Completed at", "Signature link", "Invoice number",
  "Invoice PDF", "Completion PDF", "Payment due", "Paid on"
];

// Agent/landlord invoices are payment-due invoices rather than receipts.
var AGENT_PAYMENT_TERMS_DAYS = 14;

// Late cancellation / no-access call-out fee (terms section 5), and how long
// the customer has to pay it. Only ever charged when Niall ticks the box in
// the admin app's cancel panel.
var LATE_CANCELLATION_FEE = 25;
var CANCELLATION_FEE_TERMS_DAYS = 14;
var CANCELLATION_COLUMNS = ["Cancelled at", "Cancelled by", "Cancellation note", "Cancellation fee"];

// Bank details are NOT stored in this file. They're read from the Apps
// Script project's Script Properties (Project Settings -> Script
// Properties), so they never sit in a copy of this code. Run
// checkInvoiceSettings() once after adding them to confirm they're picked up.
var BANK_PROPERTY_KEYS = {
  accountName: "BANK_ACCOUNT_NAME",
  sortCode: "BANK_SORT_CODE",
  accountNumber: "BANK_ACCOUNT_NUMBER"
};

// A second tab in the customer spreadsheet, one row per agency, holding the
// billing details the agents.html form deliberately doesn't ask for (to
// keep that form short). Created automatically. The first time an agency's
// job is completed, its name is added here with the other columns blank,
// so it's obvious which agencies still need a billing address filling in.
var AGENCIES_SHEET_NAME = "Agencies";
var AGENCIES_HEADERS = ["Business name", "Billing address", "Accounts email", "Same as"];
// "Same as": type another agency's Business name here when two rows are the
// same agency under different spellings ("Andrews Property" -> "Andrews").
// Invoices and reminders for that row then use the other row's name, billing
// address and accounts email. See getAgencyBilling.

// Drive folders for the documents completeJob() generates, each split into
// a "YYYY-MM" subfolder per month so a year's invoices are easy to hand to
// an accountant. Created automatically on first use.
var INVOICES_FOLDER_NAME = "EasyClean Somerset — Invoices";
var COMPLETIONS_FOLDER_NAME = "EasyClean Somerset — Completions";

// Possible job START times per weekday (0 = Sunday .. 6 = Saturday),
// 24-hour "HH:mm". These don't need to avoid each other or leave gaps —
// a candidate time that would overlap a real booking (or anything else
// on the calendar, like an ad hoc school-pickup block) is automatically
// filtered out by getAvailableSlots() below, so it's safe to offer one
// every hour and let real clashes do the filtering. An empty array
// means no online slots are offered that day at all (e.g. Sunday, "by
// arrangement" per the website — handle those over WhatsApp instead).
var WEEKLY_SLOTS = {
  0: [],                                                                                          // Sunday — by arrangement only
  1: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"], // Monday
  2: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"], // Tuesday
  3: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"], // Wednesday
  4: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"], // Thursday
  5: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"], // Friday
  6: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]  // Saturday
};
// ============================================================

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    // The private admin app. Only ever served to the Google account that
    // owns this script (see isOwner). Deploy it as a second web app with
    // "Who has access: Only myself" so Google itself asks for that sign-in;
    // the owner check here also blocks it on the public deployment.
    // A bare URL (no action) also opens the admin app, so the admin
    // deployment's plain /exec link works as a home-screen bookmark. The
    // website itself never calls the bare URL, and anyone who isn't the
    // owner just gets "Not available".
    if (p.page || !p.action) {
      // Anyone who isn't the owner gets plain text, never an HTML page.
      // Any HTML page served by this script lets the visitor call the
      // script's functions from their browser (google.script.run), so the
      // public deployment must never serve one.
      if (!isOwner()) return notAvailable();
      return serveAdminPage(p);
    }
    if (p.action === "slots") {
      return jsonResponse({ ok: true, slots: getAvailableSlotsCached() });
    }
    if (p.action === "job") {
      return jsonResponse(getPublicJob(p.t));
    }
    // my-booking.html: a customer viewing or moving their own booking (FRE-213)
    if (p.action === "booking") {
      return jsonResponse(getPublicBooking(p.t));
    }
    if (p.action === "rescheduleSlots") {
      return jsonResponse(getRescheduleSlots(p.t));
    }
    return jsonResponse({ ok: false, error: "unknown_action" });
  } catch (err) {
    noteProblem_("Website request failed", err);
    return jsonResponse({ ok: false, error: "server_error" });
  }
}

function notAvailable() {
  return ContentService.createTextOutput("Not available.");
}

// Public endpoints only: taking a booking, a customer signing their own
// job from an emailed/WhatsApped link carrying its secret token, and a
// customer cancelling or moving their own booking from the link in their
// emails (a different secret token, see FRE-213 below). Everything
// else (completing without a signature, sending signing links, marking
// invoices paid) happens in the private admin app via google.script.run.
function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    // Not something our own pages ever send (junk or a bot), so no alert.
    return jsonResponse({ ok: false, error: "server_error" });
  }
  try {
    if (data.action === "book") {
      var result = createBooking(data);
      if (!result.ok) noteRefusedBooking_(data, result.error);
      return jsonResponse(result);
    }
    if (data.action === "complete") {
      return jsonResponse(completeJobPublic(data));
    }
    // my-booking.html: a customer cancelling or moving their own booking (FRE-213)
    if (data.action === "cancel") {
      return jsonResponse(cancelBookingPublic(data));
    }
    if (data.action === "reschedule") {
      return jsonResponse(rescheduleBookingPublic(data));
    }
    return jsonResponse({ ok: false, error: "unknown_action" });
  } catch (err) {
    noteProblem_("Website booking or sign-off request failed", err);
    if (data && data.action === "book") noteRefusedBooking_(data, "server_error");
    return jsonResponse({ ok: false, error: "server_error" });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Shared by every HTML-building function below (the confirmation, reminder
// and thank-you emails, plus the invoice PDF) — pulled out to one place
// rather than redefined in each, so there's exactly one escaping rule to
// get right.
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// ---- Trader details on customer emails ----
// The E-Commerce Regulations 2002 ask for the trader's name, address and
// email on business emails. Same as the website footer: name and town, with
// the full address on the terms page.
var TRADER_EMAIL = "easycleansomerset@gmail.com";
var TRADER_DETAILS_URL = SITE_URL + "/terms.html#business-details";

function traderLine_() {
  return BUSINESS_NAME + " trading as EasyClean Somerset, Midsomer Norton";
}

// Added under the card in every customer email's HTML.
function traderHtml_() {
  var SANS = "Arial,Helvetica,sans-serif", SLATE = "#5C6F73", TEAL_DEEP = "#0A5960";
  var link = function (href, text) {
    return '<a href="' + href + '" style="color:' + TEAL_DEEP + ';font-weight:700;text-decoration:none;">' + text + '</a>';
  };
  return '<p style="max-width:560px;margin:14px auto 0;font-family:' + SANS + ';font-size:12px;line-height:1.6;color:' + SLATE + ';text-align:center;">' +
    escHtml(traderLine_()) + '<br>' +
    link(TRADER_DETAILS_URL, 'Business details') + ' &middot; ' + link('mailto:' + TRADER_EMAIL, TRADER_EMAIL) +
  '</p>';
}

// Every email to a customer goes out through here, so the plain-text
// version ends with the trader details too. The HTML builders add
// traderHtml_() themselves.
function sendCustomerEmail_(to, subject, textBody, opts) {
  GmailApp.sendEmail(to, subject, textBody +
    "\n\n--\n" + traderLine_() + "\nBusiness details: " + TRADER_DETAILS_URL + "\nEmail: " + TRADER_EMAIL, opts);
}

// Speed fix #2: the previous fix (one calendar lookup for the whole window,
// instead of one per candidate slot) cut the calendar work down a lot, but
// "Choose a time" was still slow — because that one remaining
// cal.getEvents() call, plus Apps Script's own per-request startup
// overhead, both sit directly in the path of every single visitor's
// request. Fix: stop doing that work on the visitor's request at all.
// A time-driven trigger (set up once, see setUpAutoRefresh() below) recomputes
// the slot list every few minutes in the background and stores it in
// CacheService, so a real visitor's request just reads a cache entry back —
// no calendar call, no per-slot loop, nothing but "hand back what's already
// sitting there." A booking still gets checked for real, live, at the
// moment it's submitted (see createBooking below), so the few minutes of
// staleness here can never actually cause a double-booking; it only means a
// slot someone just took might still be *offered* to someone else for up to
// a few minutes, and their booking attempt would then be correctly turned
// away and shown available slots. Worth that trade for a "choose a time"
// that loads instantly instead of waiting on a live calendar lookup.
var SLOTS_CACHE_KEY = "availableSlots_v1";
var SLOTS_CACHE_SECONDS = 21600; // 6 hours — CacheService's own maximum

function getAvailableSlotsCached() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(SLOTS_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  // Cache miss — most likely the very first request since this was
  // deployed, or since setUpAutoRefresh() was last run. Compute it live so
  // slots are never simply broken, and warm the cache for everyone after.
  return refreshSlotsCache();
}

function refreshSlotsCache() {
  var slots = getAvailableSlots();
  CacheService.getScriptCache().put(SLOTS_CACHE_KEY, JSON.stringify(slots), SLOTS_CACHE_SECONDS);
  return slots;
}

/**
 * Run this ONCE, manually: open this project at script.google.com, pick
 * "setUpAutoRefresh" from the function dropdown next to the Run button (top
 * toolbar), and click Run. First time only, it'll ask you to authorize it
 * (same as the original deploy) — allow it. That's it: from then on, the
 * slots cache keeps itself warm automatically, forever, with no further
 * action needed, even across future edits to this file. You only need to
 * run this again if you ever see it stop updating (Apps Script -> clock
 * icon on the left sidebar -> Triggers, to check it's still listed).
 */
function setUpAutoRefresh() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "refreshSlotsCache") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("refreshSlotsCache").timeBased().everyMinutes(10).create();
  refreshSlotsCache(); // populate it right away instead of waiting 10 minutes
}

/**
 * Run this ONCE, the same way as setUpAutoRefresh above: pick
 * "setUpCustomerSheet" from the function dropdown next to the Run button and
 * click Run. Creates a new Google Sheet called "EasyClean Somerset —
 * Customers" in your Drive, adds the header row, and remembers its ID (via
 * PropertiesService, not a constant in this file) so every future booking
 * writes itself in automatically. Safe to run again later — if a sheet's
 * already set up and reachable, it leaves it alone rather than creating a
 * second one.
 */
function setUpCustomerSheet() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty(CUSTOMER_SHEET_PROPERTY_KEY);
  if (existingId) {
    try {
      var existing = SpreadsheetApp.openById(existingId);
      Logger.log("Customer sheet already set up: " + existing.getUrl());
      return;
    } catch (e) {
      // Old ID no longer opens (sheet deleted, etc.) — fall through and
      // create a fresh one rather than leaving bookings unrecorded forever.
    }
  }
  var ss = SpreadsheetApp.create("EasyClean Somerset — Customers");
  var sheet = ss.getSheets()[0];
  sheet.setName("Bookings");
  sheet.getRange(1, 1, 1, CUSTOMER_SHEET_HEADERS.length).setValues([CUSTOMER_SHEET_HEADERS]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  CUSTOMER_SHEET_HEADERS.forEach(function (h, i) {
    if (TEXT_COLUMNS.indexOf(h) !== -1) sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat("@");
  });
  props.setProperty(CUSTOMER_SHEET_PROPERTY_KEY, ss.getId());
  Logger.log("Customer sheet created: " + ss.getUrl());
}

// Appends one row per booking to the "Bookings" sheet. Wrapped defensively
// wherever this is called — a missing sheet (setUpCustomerSheet() not run
// yet) or any Sheets error should never fail an otherwise-successful
// booking, same principle as the confirmation email below.
//
// Written by HEADER NAME, not by position. A live sheet's actual header row
// can end up in a different order than CUSTOMER_SHEET_HEADERS below, or be
// missing a column entirely, if a header was ever added to this list without
// also being added by hand to the sheet that already exists (setUpCustomerSheet()
// never retroactively adds columns — see its own comment). Writing
// positionally in that situation silently puts the wrong value under the
// wrong header (e.g. a channel value landing in a "Completed at" column) —
// this looks the value up by whatever header text is actually on the sheet,
// in whatever order it's actually in, and writes "" for a value whose header
// isn't there at all rather than shifting every later column over by one.
function appendCustomerRow(data, reference, slotLabel, jobToken) {
  var sheet = getCustomerSheet();
  if (!sheet) return; // setUpCustomerSheet() hasn't been run yet
  var headerRow = ensureColumns(sheet, ["Job token", "Access", "Booked via", "Notes", EARLY_START_COLUMN, "Est. mins", MANAGE_TOKEN_COLUMN,
    "Starts at", "Ends at", REQUEST_ID_COLUMN]);
  var byHeader = {
    "Timestamp": new Date(),
    "Reference": reference,
    "Name": data.name,
    "Phone": data.phone,
    "Email": data.email,
    "Address": data.address,
    "Items": data.items,
    "Total": data.total,
    "Payment method": data.payment,
    "Booking time": slotLabel,
    "Marketing opt-in": data.marketingOptIn ? "Yes" : "No",
    "Referral / offer code": data.referralCode || "",
    "Channel": data.channel || "Consumer",
    "Business name": data.businessName || "",
    "Site contact name": data.siteContactName || "",
    "Site contact phone": data.siteContactPhone || "",
    "Agent/Agency ID": data.agencyId || "",
    "Job token": jobToken || "",
    "Access": data.channel === "Agent/Landlord" ? accessLabel(data) : "",
    "Booked via": data.bookedVia || "Website",
    "Notes": data.notes || "",
    "Customer OK'd starting within 14 days": earlyStartRecord_(data.cancellation),
    // The estimate the customer was shown, in minutes, so the job page's
    // timer can show actual against estimate (FRE-194).
    "Est. mins": parseMinsText_(data.estTime) || "",
    // The customer's change-or-cancel link (FRE-213).
    "Manage token": data.manageToken || "",
    // The booking's time, kept here as well as in the calendar, so a job
    // never drops out of the admin app (FRE-203).
    "Starts at": data.startsAt || "",
    "Ends at": data.endsAt || "",
    // The page's one-time ID for this booking, so a retry can't book twice.
    "Request ID": data.requestId || ""
    // Completed at / Signature link / Invoice number are deliberately not
    // set here — completeJob() fills those in later, once the job's signed
    // off, the same way it already looks its columns up by header name.
  };
  var row = headerRow.map(function (header) {
    var val = Object.prototype.hasOwnProperty.call(byHeader, header) ? byHeader[header] : "";
    // Text a customer typed must never be read by Sheets as a formula.
    return typeof val === "string" && val.charAt(0) === "=" ? " " + val : val;
  });
  writeTextSafeRow(sheet, headerRow, row);
}

// Columns that must stay exactly as typed. Without this, Google Sheets turns
// "07700 900000"-style numbers into 7700900000 (losing the 0), "+44..." into
// a number, "£35" into 35 and the booking time label into a date.
var TEXT_COLUMNS = ["Reference", "Name", "Phone", "Email", "Address", "Items", "Total", "Payment method",
  "Booking time", "Referral / offer code", "Business name", "Site contact name", "Site contact phone",
  "Agent/Agency ID", "Job token", "Access", "Booked via", "Notes", "Changes", "Manage token"];

function columnLetter(n) {
  var s = "";
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Writes one new row at the bottom, with the text columns set to plain
// text first so Sheets keeps them exactly as written.
function writeTextSafeRow(sheet, headerRow, row) {
  var r = sheet.getLastRow() + 1;
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  var cells = [];
  headerRow.forEach(function (h, i) { if (TEXT_COLUMNS.indexOf(h) !== -1) cells.push(columnLetter(i + 1) + r); });
  if (cells.length) sheet.getRangeList(cells).setNumberFormat("@");
  sheet.getRange(r, 1, 1, row.length).setValues([row]);
}

// A phone number read back from the sheet, as text with its leading 0 (or
// +) restored if Sheets stored it as a number in older rows.
function phoneText(val) {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "number") {
    var d = String(Math.round(val));
    if (d.length === 10) return "0" + d;
    if (d.length === 12 && d.indexOf("44") === 0) return "+" + d;
    return d;
  }
  return String(val);
}

// Opens the customer sheet, keyed by header name rather than a hardcoded
// column index — the sheet's columns have already grown twice (agent
// fields, then completion fields) and will likely grow again, so reads
// built this way keep working without editing every function that reads a
// row every time a column gets added. Returns null if the sheet hasn't
// been set up yet.
function getCustomerSheet() {
  var sheetId = PropertiesService.getScriptProperties().getProperty(CUSTOMER_SHEET_PROPERTY_KEY);
  if (!sheetId) return null;
  return SpreadsheetApp.openById(sheetId).getSheetByName("Bookings");
}

function rowToObject(headerRow, valuesRow) {
  var obj = {};
  headerRow.forEach(function (header, i) { obj[header] = valuesRow[i]; });
  return obj;
}

// Finds a booking by its "EC-XXXX" reference. Returns { rowIndex (1-based,
// ready to use with sheet.getRange), values (object keyed by header name) }
// or null if the sheet isn't set up yet or nothing matches.
function findBookingRow(reference) {
  var sheet = getCustomerSheet();
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var headerRow = data[0];
  var refCol = headerRow.indexOf("Reference");
  for (var i = 1; i < data.length; i++) {
    if (data[i][refCol] === reference) {
      return { rowIndex: i + 1, values: rowToObject(headerRow, data[i]) };
    }
  }
  return null;
}

// Every calendar event this system creates starts its description with
// "Reference: EC-XXXX" (see createBooking below) — a fixed, predictable
// first line, so pulling it back out is a plain string match, not fragile
// parsing of free text.
function referenceFromEvent(event) {
  var description = event.getDescription() || "";
  var match = description.match(/Reference:\s*(EC-\d+)/);
  return match ? match[1] : null;
}

function getAvailableSlots() {
  return computeSlots_({});
}

// The times we offer. Options, used when a customer moves a booking:
//   ignoreReference: that booking's own event doesn't count as busy;
//   lengthMins: how long the job takes (default SLOT_MINS);
//   skipStartMs: leave out this start time (the one they already have).
function computeSlots_(opts) {
  opts = opts || {};
  var lengthMins = opts.lengthMins > 0 ? opts.lengthMins : SLOT_MINS;
  var cal = CalendarApp.getDefaultCalendar();
  var now = new Date();
  var earliest = new Date(now.getTime() + LEAD_TIME_HOURS * 3600000);

  var rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var rangeEnd = new Date(rangeStart.getTime());
  rangeEnd.setDate(rangeEnd.getDate() + DAYS_AHEAD);

  // Speed fix: this used to call cal.getEvents() once per candidate slot
  // (100+ separate calendar lookups for a multi-week, hourly-slot window),
  // which is what made "choose a time" slow to load. Instead, fetch the
  // whole window's events in ONE calendar lookup, then check each
  // candidate slot against that single in-memory list. Same result, a
  // fraction of the wait.
  var busy = cal.getEvents(rangeStart, rangeEnd).filter(function (ev) {
    return !opts.ignoreReference || referenceFromEvent(ev) !== opts.ignoreReference;
  }).map(function (ev) {
    return { start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime() };
  });

  function overlapsBusy(start, end) {
    var s = start.getTime();
    var e = end.getTime();
    for (var i = 0; i < busy.length; i++) {
      if (s < busy[i].end && e > busy[i].start) return true;
    }
    return false;
  }

  var closed = closedDaySet();
  var slots = [];
  for (var d = 0; d < DAYS_AHEAD; d++) {
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    if (closed[Utilities.formatDate(day, TIMEZONE, "yyyy-MM-dd")] || closed[Utilities.formatDate(day, TIMEZONE, "MM-dd")]) continue;
    var weekday = day.getDay();
    var times = WEEKLY_SLOTS[weekday] || [];

    times.forEach(function (t) {
      var parts = t.split(":");
      var start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), parseInt(parts[0], 10), parseInt(parts[1], 10));
      var end = new Date(start.getTime() + lengthMins * 60000);
      if (start < earliest) return;
      if (opts.skipStartMs && start.getTime() === opts.skipStartMs) return;
      if (overlapsBusy(start, end)) return;

      slots.push({
        start: start.toISOString(),
        dayLabel: Utilities.formatDate(start, TIMEZONE, "EEE d MMM"),
        timeLabel: Utilities.formatDate(start, TIMEZONE, "h:mma")
      });
    });
  }
  return slots;
}

// Public entry point for a booking. Everything the browser sends is
// treated as untrusted: spam trap, booking-rate cap, a slot check against
// the times we actually offer, and the price recalculated from the live
// price list. One booking at a time (script lock) so two people can't take
// the same slot at the same moment.
function createBooking(data) {
  // Spam trap: a hidden field real visitors never see or fill in. Bots that
  // fill every field get a fake "ok" and nothing is booked.
  if (data.website) {
    console.warn("Honeypot booking ignored");
    return { ok: true, reference: "EC-00000" };
  }
  if (!data.startTime || !data.name || !data.phone || !data.email || !data.address) {
    return { ok: false, error: "missing_fields" };
  }
  var badInput = validateBookingInput(data);
  if (badInput) return { ok: false, error: badInput };
  data.requestId = cleanRequestId_(data.requestId);
  data.notes = websiteBookingNotes_(data);
  var rate = bookingRateExceeded();
  if (rate) {
    if (rate === true) notifyOwner("Bookings paused: unusual number in the last hour",
      "More than " + MAX_BOOKINGS_PER_HOUR + " bookings (or " + MAX_ATTEMPTS_PER_HOUR + " booking attempts) arrived within an hour, " +
      "so new ones are being turned away for now (customers see the WhatsApp fallback). " +
      "Check your calendar for fake bookings. It resets on its own within the hour.");
    return { ok: false, error: "busy" };
  }
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return { ok: false, error: "busy" };
  }
  try {
    // The same booking sent again (the page retrying after a dropped
    // connection): answer with the booking already made, never a second one.
    var earlier = data.requestId ? bookingForRequestId_(data.requestId) : null;
    if (earlier) return { ok: true, reference: earlier, repeat: true };
    var result = createBookingLocked_(data);
    if (result && result.ok) countBooking();
    return result;
  } finally {
    lock.releaseLock();
  }
}

// Server-side checks on what the browser sent. The page checks these too,
// but anyone can post straight to this script. The important one is the
// email: exactly one normal address, so a booking can never be used to
// send the confirmation email to a list of other people.
var EMAIL_PATTERN = /^[^\s@,;:<>()\[\]"\\]+@[^\s@,;:<>()\[\]"'\\]+\.[A-Za-z]{2,}$/;

function validateBookingInput(data) {
  var str = function (v) { return typeof v === "string" ? v.trim() : (v === undefined || v === null ? "" : String(v)); };
  data.email = str(data.email);
  data.name = str(data.name);
  data.phone = str(data.phone);
  data.address = str(data.address);
  if (data.email.length > 254 || !EMAIL_PATTERN.test(data.email)) return "bad_details";
  if (!data.name || data.name.length > 100) return "bad_details";
  // Phone: free text is fine ("07700 900000, evenings"), as long as there's a number in it.
  if (data.phone.length > 40 || data.phone.replace(/\D/g, "").length < 7) return "bad_details";
  if (!data.address || data.address.length > 300) return "bad_details";
  var limits = { postcode: 12, businessName: 120, siteContactName: 100, siteContactPhone: 40, agencyId: 60, referralCode: 40, slotLabel: 80, parking: 60, notes: 400 };
  for (var k in limits) {
    if (data[k] !== undefined && data[k] !== null && String(data[k]).length > limits[k]) return "bad_details";
  }
  if (Array.isArray(data.lineItems) && data.lineItems.length > 40) return "bad_items";
  if (data.items && String(data.items).length > 2000) return "bad_items";
  return null;
}

// The booking form's optional parking answer and notes box, as one line for
// the Notes column, calendar event and admin app ("Parking: ... . notes").
// Kept on one line, like notes typed in the admin app.
function websiteBookingNotes_(data) {
  var str = function (v) { return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""; };
  var parking = str(data.parking);
  return [parking ? "Parking: " + parking + "." : "", str(data.notes)].filter(String).join(" ");
}

// ---- Asking for the extras by reply (FRE-209) ----
// The booking forms tuck parking, pets and notes under a closed "Anything
// else?" link, so many customers leave them empty. The confirmation and
// day-before emails ask for them by reply, but only when the Notes are empty.
// Notes already holds the parking answer too (see websiteBookingNotes_).
var EXTRAS_ASK_TEXT = "Reply to this email with anything we should know: parking, pets, gate codes, stains you'd like us to look at.";

function needsExtrasAsk_(notes) {
  return !String(notes || "").trim();
}

function extrasAskHtml_() {
  var SANS = "Arial,Helvetica,sans-serif", INK = "#12232B", PAPER = "#F5F7F6", TEAL = "#0E7C86";
  return '<p style="margin:0;padding:12px 14px;border-left:3px solid ' + TEAL + ';background:' + PAPER + ';font-family:' + SANS + ';font-size:14px;line-height:1.55;color:' + INK + ';">' +
    escHtml(EXTRAS_ASK_TEXT).replace("&#39;", "&#8217;") + '</p>';
}

// ---- Consumer Contracts Regulations 2013: the 14-day right to cancel ----
// A homeowner who books online, by phone or by message can cancel within 14
// days, counting from the day after booking. To clean inside that time the
// law needs them to ask us to: the tick box on the website, sent as
// earlyStart. Agent and landlord bookings are business bookings, so none of
// this applies to them. Returns null for those.
var CANCEL_DAYS = 14;

function cancellationInfo_(data, start, bookedAt) {
  if (data.channel === "Agent/Landlord") return null;
  bookedAt = bookedAt || new Date();
  var p = Utilities.formatDate(bookedAt, TIMEZONE, "yyyy-MM-dd").split("-");
  var lastDay = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + CANCEL_DAYS, 12)); // midday, so the date is right in UK time
  return {
    bookedOn: Utilities.formatDate(bookedAt, TIMEZONE, "d MMMM yyyy"),
    deadline: Utilities.formatDate(lastDay, TIMEZONE, "EEEE d MMMM yyyy"),
    within: start ? calendarDaysBetween_(bookedAt, start) <= CANCEL_DAYS : false,
    earlyStart: data.earlyStart === true
  };
}

// The sheet column recording whether a homeowner asked us to start their
// clean within their 14-day cancellation period (the tick box on the home
// page). It was called "Early start request" until 9 Oct 2026; the old
// column is renamed, and its values reworded, the first time the sheet's
// columns are checked (see ensureColumns).
var EARLY_START_COLUMN = "Customer OK'd starting within 14 days";
var EARLY_START_OLD_COLUMN = "Early start request";
var EARLY_START_VALUES = {
  booked: "Yes, ticked when booking",
  moved: "Yes, ticked when moving online",
  notNeeded: "Not needed, clean is after 14 days",
  missing: "No, ask the customer"
};
var EARLY_START_OLD_VALUES = {
  "Yes, ticked at booking": EARLY_START_VALUES.booked,
  "Yes, ticked when moving online": EARLY_START_VALUES.moved,
  "Not needed (clean is after the 14 days)": EARLY_START_VALUES.notNeeded,
  "Not given": EARLY_START_VALUES.missing
};

// What goes in that column for a new booking.
function earlyStartRecord_(c) {
  if (!c) return "";
  if (!c.within) return EARLY_START_VALUES.notNeeded;
  return c.earlyStart ? EARLY_START_VALUES.booked : EARLY_START_VALUES.missing;
}

// The cancellation information and model cancellation form for the
// confirmation email (Schedule 3 of the regulations), as plain text.
// FRE-212: the form normally goes out as a PDF attached to the email
// (formAttached true), so the email just says so. If the PDF couldn't be
// made, the form goes in the email instead, as before.
function cancellationText_(c, reference, formAttached, hasButton) {
  var head = "YOUR RIGHT TO CANCEL\n" +
    "You can cancel this booking within 14 days without giving a reason, so until " + c.deadline + ". " +
    cancelHowText_(formAttached, hasButton) + "\n" +
    (c.within && c.earlyStart ? "You asked us to do your clean within those 14 days. If you cancel after we've started, you'll pay for the work done up to then. Once the clean is complete, you can no longer cancel.\n" : "") +
    "Full details are in section 11 of our terms: " + SITE_URL + "/terms.html#cancel";
  if (formAttached) return head;
  return head + "\n\n" +
    "CANCELLATION FORM\n" +
    "(Only fill in and send this form if you want to cancel.)\n" +
    "To: " + BUSINESS_NAME + " trading as EasyClean Somerset, " + BUSINESS_ADDRESS + ". Email: " + TRADER_EMAIL + "\n" +
    "I/We hereby give notice that I/We cancel my/our contract for the supply of the following service: cleaning, booking reference " + reference + "\n" +
    "Ordered on: " + c.bookedOn + "\n" +
    "Name of consumer(s):\n" +
    "Address of consumer(s):\n" +
    "Signature of consumer(s) (only if this form is sent on paper):\n" +
    "Date:";
}

// The same, for the HTML confirmation email.
// How to cancel, for the right-to-cancel section. hasButton: the email has
// the Change or cancel button (FRE-213).
function cancelHowText_(formAttached, hasButton) {
  return (hasButton ? "Use the Change or cancel button above, reply to this email, WhatsApp us," : "Reply to this email, WhatsApp us,") +
    " or use the " + (formAttached ? "cancellation form attached" : "form below") + ".";
}

function cancellationHtml_(c, reference, k, formAttached, hasButton) {
  var esc = escHtml;
  var p = function (text, extra) {
    return '<p style="margin:0 0 10px;font-family:' + k.SANS + ';font-size:13.5px;line-height:1.6;color:' + k.SLATE + ';' + (extra || '') + '">' + text + '</p>';
  };
  var formLine = function (label, value) {
    return '<p style="margin:0 0 6px;font-family:' + k.SANS + ';font-size:13px;line-height:1.5;color:' + k.INK + ';">' + label + (value ? ' <strong>' + esc(value) + '</strong>' : '') + '</p>';
  };
  return (
    '<tr><td style="background:' + k.SURFACE + ';border-left:1px solid ' + k.LINE + ';border-right:1px solid ' + k.LINE + ';padding:4px 28px 28px;">' +
      '<div style="border-top:1px solid ' + k.LINE + ';padding-top:22px;">' +
        '<div style="font-family:' + k.SANS + ';font-weight:bold;font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:' + k.SLATE + ';margin-bottom:8px;">Your right to cancel</div>' +
        p('You can cancel this booking within 14 days without giving a reason, so until <strong style="color:' + k.INK + ';">' + esc(c.deadline) + '</strong>. ' + esc(cancelHowText_(formAttached, hasButton))) +
        (c.within && c.earlyStart ? p('You asked us to do your clean within those 14 days. If you cancel after we&#8217;ve started, you&#8217;ll pay for the work done up to then. Once the clean is complete, you can no longer cancel.') : '') +
        p('Full details are in <a href="' + SITE_URL + '/terms.html#cancel" style="color:' + k.TEAL_DEEP + ';font-weight:700;">section 11 of our terms</a>.', formAttached ? 'margin-bottom:0;' : 'margin-bottom:16px;') +
        (formAttached ? '' :
        '<div style="border:1px dashed ' + k.LINE + ';border-radius:4px;padding:16px 18px;background:' + k.PAPER + ';">' +
          '<div style="font-family:' + k.SANS + ';font-weight:bold;font-size:14px;color:' + k.INK + ';margin-bottom:2px;">Cancellation form</div>' +
          '<p style="margin:0 0 12px;font-family:' + k.SANS + ';font-size:12.5px;color:' + k.SLATE + ';">(Only fill in and send this form if you want to cancel.)</p>' +
          formLine('To:', BUSINESS_NAME + ' trading as EasyClean Somerset, ' + BUSINESS_ADDRESS + '. Email: ' + TRADER_EMAIL) +
          formLine('I/We hereby give notice that I/We cancel my/our contract for the supply of the following service:', 'cleaning, booking reference ' + reference) +
          formLine('Ordered on:', c.bookedOn) +
          formLine('Name of consumer(s):') +
          formLine('Address of consumer(s):') +
          formLine('Signature of consumer(s) (only if this form is sent on paper):') +
          formLine('Date:') +
        '</div>') +
      '</div>' +
    '</td></tr>'
  );
}

// FRE-212: the model cancellation form (Schedule 3 of the regulations) as
// a one-page PDF, attached to a homeowner's confirmation email. A PDF the
// customer keeps counts as a "durable medium"; a link to a web page
// wouldn't. Pre-filled with the booking reference, the date they booked,
// and their name and address, so they only need to sign, date and send it.
var CANCELLATION_FORM_FILE_PREFIX = "EasyClean-Somerset-cancellation-form-";

function cancellationFormPdf_(c, reference, customer) {
  var esc = escHtml;
  customer = customer || {};
  var address = String(customer.address || "");
  var postcode = String(customer.postcode || "").trim();
  if (postcode && address.toUpperCase().replace(/\s/g, "").indexOf(postcode.toUpperCase().replace(/\s/g, "")) === -1) {
    address += (address ? ", " : "") + postcode.toUpperCase();
  }
  var field = function (label, value, tall) {
    return '<tr><td class="lab">' + label + '</td><td class="val' + (tall ? ' tall' : '') + '">' + (value ? esc(value) : '&nbsp;') + '</td></tr>';
  };
  var html =
    '<html><head><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#12232B;font-size:12px;line-height:1.5;margin:0;padding:32px;}' +
    'h1{font-size:20px;margin:0 0 2px;}' +
    '.muted{color:#5C6F73;}' +
    '.strong{font-weight:bold;}' +
    '.label{font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#5C6F73;margin-bottom:4px;}' +
    '.layout{width:100%;border-collapse:collapse;margin:0 0 22px;}' +
    '.layout td{border:none;padding:0;vertical-align:top;}' +
    '.half{width:50%;}' +
    '.brand img{width:32px;height:32px;vertical-align:middle;margin-right:8px;}' +
    '.brand h1{display:inline;vertical-align:middle;}' +
    '.note{padding:12px 14px;background:#F5F7F6;border-left:3px solid #0E7C86;margin:0 0 22px;}' +
    'table.form{width:100%;border-collapse:collapse;}' +
    'table.form td{padding:10px 0;border-bottom:1px solid #DCE3E2;vertical-align:top;}' +
    'table.form .lab{width:42%;padding-right:16px;color:#5C6F73;}' +
    'table.form .val{font-weight:bold;}' +
    'table.form .tall{height:44px;}' +
    '.foot{margin-top:26px;font-size:11px;color:#5C6F73;}' +
    '</style></head><body>' +
    '<table class="layout"><tr>' +
      '<td class="half">' +
        '<div class="brand"><img src="' + SITE_URL + '/apple-touch-icon.png" width="32" height="32" alt="" /><h1>Cancellation form</h1></div>' +
        '<div class="muted">Booking ref ' + esc(reference) + '</div>' +
      '</td>' +
      '<td class="half" style="text-align:right;">' +
        '<div class="strong">' + esc(BUSINESS_NAME) + '</div>' +
        '<div class="muted">trading as EasyClean Somerset</div>' +
        '<div class="muted">' + esc(BUSINESS_ADDRESS) + '</div>' +
        '<div class="muted">' + esc(TRADER_EMAIL) + '</div>' +
      '</td>' +
    '</tr></table>' +
    '<div class="note">' +
      '<div class="strong">Only fill in and send this form if you want to cancel.</div>' +
      'You can cancel until <span class="strong">' + esc(c.deadline) + '</span> without giving a reason. ' +
      'You don&#8217;t have to use this form: a WhatsApp message or a reply to your confirmation email is just as good. ' +
      'Full details are in section 11 of our terms (' + esc(SITE_URL.replace(/^https?:\/\//, "")) + '/terms.html#cancel).' +
    '</div>' +
    '<div class="label">Cancellation form</div>' +
    '<table class="form">' +
      field('To', BUSINESS_NAME + ' trading as EasyClean Somerset, ' + BUSINESS_ADDRESS + '. Email: ' + TRADER_EMAIL) +
      field('I/We hereby give notice that I/We cancel my/our contract for the supply of the following service', 'Cleaning, booking reference ' + reference) +
      field('Ordered on', c.bookedOn) +
      field('Name of consumer(s)', customer.name || '') +
      field('Address of consumer(s)', address) +
      field('Signature of consumer(s) (only if this form is sent on paper)', '', true) +
      field('Date', '', true) +
    '</table>' +
    '<div class="foot">Send it by email to ' + esc(TRADER_EMAIL) + ', or by post to ' + esc(BUSINESS_ADDRESS) + '.</div>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).getAs("application/pdf").setName(CANCELLATION_FORM_FILE_PREFIX + reference + ".pdf");
}

function createBookingLocked_(data) {
  // The agent/landlord form (agents.html) needs either a named contact on
  // site or the agent choosing to arrange access with us at least 24 hours
  // before. Enforced here too, since both forms POST to this same endpoint.
  // The business name is optional: a private landlord without one books
  // under their own name, the same as in the admin app.
  if (data.channel === "Agent/Landlord") {
    if (!data.businessName) data.businessName = data.name;
    if (!data.accessArrange && (!data.siteContactName || !data.siteContactPhone)) {
      return { ok: false, error: "missing_fields" };
    }
  }

  // Postcode must be inside the service area (service-area.js on the site).
  var area = checkServiceArea(data);
  if (!area.ok) return { ok: false, error: area.error };
  data.areaUnchecked = !area.verified;

  var start = new Date(data.startTime);
  if (!isOfferableSlot(start)) {
    return { ok: false, error: "slot_taken" };
  }
  // Never refused over this: a missing early-start request is flagged to
  // Niall instead (the page may have been opened before the box was added).
  data.cancellation = cancellationInfo_(data, start, new Date());
  var end = new Date(start.getTime() + SLOT_MINS * 60000);
  data.startsAt = start;
  data.endsAt = end;
  var cal = CalendarApp.getDefaultCalendar();

  // Re-price from the live price list. The browser's own items/total/time
  // are only used if the price list can't be read at all, and you're told.
  var priced = priceBooking(data);
  if (!priced.ok) return { ok: false, error: priced.error };
  data.items = priced.items;
  data.total = priced.total;
  data.estTime = priced.estTime;

  // Re-check the slot is still free — someone else may have grabbed it
  // between the site loading the slot list and this request arriving.
  var clashes = cal.getEvents(start, end);
  if (clashes.length > 0) {
    return { ok: false, error: "slot_taken" };
  }

  var reference = newBookingReference();
  var jobToken = newJobToken();
  // The customer's own link for changing or cancelling (FRE-213). Separate
  // from the job token, so it can never sign off a job.
  data.manageToken = newJobToken();
  var title = bookingEventTitle_(data);
  // "Job link" is for Niall, not the customer — it's only ever written into
  // this calendar event's own description, never into the customer-facing
  // confirmation email. It opens this job in the private admin app (Google
  // sign-in required), where he gets the signature and marks it done.
  var jobLink = adminJobLink(jobToken, reference);
  var description = bookingEventDescription_(data, reference, jobLink);

  cal.createEvent(title, start, end, {
    description: description,
    location: data.address
  });
  rememberRequestId_(data.requestId, reference);

  // Update the cached slot list right away so this slot stops being offered
  // to the next visitor immediately, rather than waiting for the next
  // scheduled refresh (up to 10 minutes away). Wrapped defensively: a
  // problem refreshing the cache should never fail an otherwise-successful
  // booking — the booking above has already been created either way.
  try {
    refreshSlotsCache();
  } catch (cacheErr) {
    noteProblem_("Refreshing available times after a booking failed", cacheErr);
  }

  try {
    var slotLabel = data.slotLabel || Utilities.formatDate(start, TIMEZONE, "EEE d MMM 'at' h:mma");
    sendBookingConfirmation_(data, reference, slotLabel);
  } catch (mailErr) {
    // The calendar event is already created at this point, which is what
    // actually matters — a failed confirmation email shouldn't fail the
    // whole booking. Logged so it's visible in Apps Script's execution log.
    noteProblem_("Confirmation email failed", mailErr);
    notifyOwner("Confirmation email failed for " + reference,
      "The booking is in your calendar, but the customer's confirmation email didn't send (" + mailErr + "). " +
      "Their email was entered as: " + data.email + ". Worth checking it and contacting them directly.");
  }

  try {
    var recordedSlotLabel = data.slotLabel || Utilities.formatDate(start, TIMEZONE, "EEE d MMM 'at' h:mma");
    appendCustomerRow(data, reference, recordedSlotLabel, jobToken);
  } catch (sheetErr) {
    // Same principle as the email above: the calendar event is already
    // created, so a problem writing to the customer sheet should never fail
    // the booking itself. Logged so it's visible in Apps Script's execution
    // log if it ever needs investigating.
    noteProblem_("Writing a booking to the customer sheet failed", sheetErr);
    notifyOwner("Customer sheet not updated for " + reference,
      "The booking is in your calendar, but it couldn't be added to the customer sheet (" + sheetErr + "), " +
      "so it won't appear in the admin app. Add the row by hand from the calendar event.");
  }

  if (data.channel === "Agent/Landlord") {
    try {
      data.agencyCheck = findOrAddAgency_(data.businessName);
    } catch (agencyErr) {
      noteProblem_("Checking the Agencies tab failed for " + reference, agencyErr);
    }
  }

  try {
    sendNewBookingAlert(data, reference, jobToken, start, priced);
  } catch (alertErr) {
    noteProblem_("New-booking alert to you failed", alertErr);
  }

  return { ok: true, reference: reference };
}


// ---- Shared by website bookings and bookings made in the admin app ----

function bookingEventTitle_(d) {
  return d.channel === "Agent/Landlord"
    ? "Clean (Agent): " + d.businessName + " (" + d.total + ")"
    : "Clean: " + d.name + " (" + d.total + ")";
}

// The calendar event's description. Always starts "Reference: EC-…", which
// is how every other part of the system finds the booking again.
function bookingEventDescription_(d, reference, jobLink) {
  var lines = [
    "Reference: " + reference,
    "What needs cleaning: " + d.items,
    "Est. time: " + (d.estTime || "not specified"),
    "Total: " + d.total,
    "Phone: " + d.phone,
    "Email: " + d.email,
    "Payment: " + d.payment
  ];
  // Agent/landlord-only fields: the person on site usually isn't the
  // person who made the booking.
  if (d.channel === "Agent/Landlord") {
    lines.push("Business: " + d.businessName);
    lines.push(d.accessArrange
      ? "Access: AGENT TO ARRANGE, they'll get in touch at least 24 hours before (no one named on site)"
      : "Site contact: " + d.siteContactName + " (" + d.siteContactPhone + ")");
    if (d.agencyId) lines.push("Agent/Agency ID: " + d.agencyId);
  }
  if (d.referralCode) lines.push("Referral/offer code: " + d.referralCode);
  if (d.notes) lines.push("Notes: " + d.notes);
  if (d.bookedVia === "Admin app") lines.push("Booked via: admin app");
  lines.push(JOB_LINK_LABEL + jobLink);
  return lines.join("\n");
}

function sendBookingConfirmation_(data, reference, slotLabel) {
  // Website bookings work this out with the job's time. Admin-app bookings
  // still get the information and form, but never the early-start line.
  var cancel = data.cancellation || cancellationInfo_(data, null, new Date());
  // FRE-212: homeowners get the cancellation form as a PDF attachment. If it
  // can't be made, the form goes in the email as before, so they always get it.
  var formPdf = null;
  if (cancel) {
    try {
      formPdf = cancellationFormPdf_(cancel, reference, data);
    } catch (pdfErr) {
      noteProblem_("Cancellation form PDF for " + reference + " (form put in the email instead)", pdfErr);
    }
  }
  var askExtras = needsExtrasAsk_(data.notes);
  var manageUrl = manageLink_(data.manageToken);
  var waLink = "https://wa.me/" + WHATSAPP_NUMBER + "?text=" +
    encodeURIComponent("Hi EasyClean Somerset, I need to change my booking. Ref: " + reference);
  // Plain-text fallback — shown by the small number of mail clients that
  // don't render HTML at all, and used by spam filters that inspect it.
  // Deliberately kept simple; all the branding lives in the HTML version.
  var textBody = "Hi " + data.name + ",\n\n" +
    "You're booked in with EasyClean Somerset.\n\n" +
    "When: " + slotLabel + "\n" +
    "What: " + data.items + "\n" +
    "Total: " + data.total + " (" + data.payment + ")\n" +
    "Where: " + data.address + "\n" +
    (data.channel === "Agent/Landlord" ? "Access: " + accessEmailText(data) + "\n" : "") + "\n" +
    "Reference: " + reference + ". Keep this handy if you need to get in touch.\n\n" +
    (askExtras ? EXTRAS_ASK_TEXT + "\n\n" : "") +
    changeText_(manageUrl, waLink, "Need to change anything? Just reply to this email or WhatsApp us: ") + "\n\n" +
    (cancel ? cancellationText_(cancel, reference, !!formPdf, !!manageUrl) + "\n\n" : "") +
    "Thanks,\nEasyClean Somerset";

  var htmlBody = buildConfirmationEmailHtml({
    name: data.name,
    slotLabel: slotLabel,
    items: data.items,
    total: data.total,
    payment: data.payment,
    address: data.address,
    reference: reference,
    waLink: waLink,
    access: data.channel === "Agent/Landlord" ? accessEmailText(data) : "",
    askExtras: askExtras,
    cancel: cancel,
    formAttached: !!formPdf,
    manageUrl: manageUrl
  });

  var opts = { htmlBody: htmlBody, name: "EasyClean Somerset" };
  if (formPdf) opts.attachments = [formPdf];
  sendCustomerEmail_(data.email, "Booking confirmed: " + slotLabel, textBody, opts);
}

// FRE-212: run this from the Apps Script editor to see a sample homeowner
// confirmation email, with the cancellation form PDF attached, in your own
// inbox. Nothing is booked, and nothing is written to the sheet or calendar.
function sendTestConfirmationEmail() {
  var me = Session.getEffectiveUser().getEmail();
  var data = {
    name: "Test Customer", email: me, address: "1 High Street, Midsomer Norton", postcode: "BA3 2AA",
    items: "2× Medium room: £90", total: "£90", payment: "Cash", channel: "Consumer", notes: "", earlyStart: true
  };
  data.cancellation = cancellationInfo_(data, new Date(Date.now() + 5 * 86400000), new Date());
  sendBookingConfirmation_(data, "EC-TEST", "Test only, nothing booked");
  Logger.log("Sent a sample confirmation email to " + me + ".");
}

// Builds the branded HTML confirmation email. Written the way marketing
// email HTML has to be written to survive real inboxes: everything laid
// out with <table>s and every style attribute inline, rather than a
// <style> block or CSS classes — Gmail, Outlook and a lot of mobile mail
// apps strip or ignore both of those, and inline styles are the one thing
// every client reliably keeps. Fonts fall back to plain system fonts
// (Arial/Helvetica, Courier New) rather than depending on the site's
// Google Fonts loading inside an email client, which is unreliable —
// the colours, spacing and layout carry the branding here, not the exact
// typeface. Deliberately avoids anything Outlook's rendering engine mangles
// (CSS gradients, transforms/rotation, box-shadow) — the "premium" feel
// comes from generous whitespace, a restrained accent colour, and a couple
// of small bespoke details (the monogram, the reference stub) rather than
// effects that only work in modern clients.
function buildConfirmationEmailHtml(d) {
  var esc = escHtml;

  var INK = "#12232B";
  var INK_SOFT = "#2A3D46";
  var TEAL = "#0E7C86";        // the site's actual --teal token (light mode, what most visitors see)
  var TEAL_DEEP = "#0A5960";   // the site's --teal-deep token
  var TEAL_TINT = "#E4F0F0";
  var PAPER = "#F5F7F6";
  var SURFACE = "#FFFFFF";
  var LINE = "#DCE3E2";
  var SLATE = "#5C6F73";
  var STAMP = "#B5461E";
  var ON_INK = "#F5F7F6";
  var SANS = "Arial,Helvetica,sans-serif";
  var LOGO_URL = "https://easycleansomerset.co.uk/apple-touch-icon.png"; // the real brand-kit icon mark, same file the site's own favicon uses

  // Stacked label-above-value rather than side-by-side label/value: a
  // side-by-side layout looks fine for short fields like "Total", but
  // "What" (a multi-item list) and "Where" (a full address) can run long,
  // and a right-aligned value wraps raggedly against a narrow mail-client
  // viewport. Stacking keeps every field left-aligned and readable
  // regardless of how much text is in it.
  function detailRow(label, value, isLast) {
    var borderStyle = isLast ? "" : "border-bottom:1px solid " + LINE + ";";
    return (
      '<tr><td style="padding:16px 0;' + borderStyle + '">' +
        '<div style="font-family:' + SANS + ';font-weight:bold;font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:' + SLATE + ';margin-bottom:5px;">' + label + '</div>' +
        '<div style="font-family:' + SANS + ';font-size:15.5px;font-weight:600;color:' + INK + ';line-height:1.5;">' + value + '</div>' +
      '</td></tr>'
    );
  }

  return (
    '<div style="background:' + PAPER + ';padding:40px 16px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">' +

        // Thin top accent bar — a small "letterhead" touch above the header
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +

        // Header band — the real brand-kit icon mark (same PNG the site's own
        // favicon uses, hosted at the live domain) + wordmark lockup, plus a
        // small tagline. Previously an invented CSS-drawn "ES" box in a
        // monospace font — replaced with the actual logo image once one
        // existed, so the email matches the real thing pixel-for-pixel
        // instead of approximating it.
        '<tr><td style="background:' + INK + ';padding:36px 28px 30px;text-align:center;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">' +
            '<tr>' +
              '<td style="width:44px;height:44px;vertical-align:middle;">' +
                '<img src="' + LOGO_URL + '" width="44" height="44" alt="EasyClean Somerset" style="display:block;width:44px;height:44px;" />' +
              '</td>' +
              '<td style="width:14px;font-size:14px;">&nbsp;</td>' +
              '<td style="text-align:left;vertical-align:middle;">' +
                '<span style="font-family:' + SANS + ';font-weight:800;font-size:21px;letter-spacing:0.01em;text-transform:uppercase;color:' + ON_INK + ';">Easy<span style="color:' + TEAL + ';">Clean</span> Somerset</span>' +
              '</td>' +
            '</tr>' +
          '</table>' +
          '<div style="margin-top:16px;font-family:' + SANS + ';font-weight:bold;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:' + TEAL + ';">Carpet &middot; Upholstery &middot; Mattress Cleaning</div>' +
        '</td></tr>' +

        // Body card
        '<tr><td style="background:' + SURFACE + ';border-left:1px solid ' + LINE + ';border-right:1px solid ' + LINE + ';padding:36px 28px 8px;">' +

          // Eyebrow tag + heading — the tag now mirrors the site's own
          // .offer-tag pill exactly: solid teal fill, on-ink text, fully
          // rounded, mono uppercase, rather than an invented flat tint box.
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="background:' + TEAL + ';padding:5px 12px;border-radius:20px;">' +
            '<span style="font-family:' + SANS + ';font-weight:bold;font-size:11.5px;letter-spacing:0.08em;text-transform:uppercase;color:' + ON_INK + ';">Booking Confirmed</span>' +
          '</td></tr></table>' +
          '<p style="margin:0 0 6px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Hi ' + esc(d.name) + ',</p>' +
          '<h1 style="margin:0 0 6px;font-family:' + SANS + ';font-weight:800;font-size:27px;letter-spacing:-0.01em;color:' + INK + ';">You&#8217;re booked in</h1>' +
          '<div style="width:36px;height:3px;background:' + STAMP + ';margin:0 0 18px;font-size:3px;line-height:3px;">&nbsp;</div>' +
          '<p style="margin:0 0 28px;font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + SLATE + ';">Thanks for booking with EasyClean Somerset. Here&#8217;s everything for your appointment.</p>' +

          // Reference stub — now built on the site's own card language
          // (.path / .seal: a bordered card with a coloured top accent and
          // rounded corners) instead of an invented left-side stripe. The
          // separate "Confirmed" badge was dropped: with the pill above
          // already saying "Booking Confirmed", repeating it here was
          // redundant clutter rather than a second useful signal.
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + LINE + ';border-top:3px solid ' + TEAL + ';border-radius:4px;margin-bottom:28px;">' +
            '<tr><td style="padding:16px 18px;">' +
              '<div style="font-family:' + SANS + ';font-weight:bold;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:' + SLATE + ';margin-bottom:4px;">Reference</div>' +
              '<div style="font-family:' + SANS + ';font-size:17px;font-weight:bold;letter-spacing:0.01em;color:' + TEAL_DEEP + ';">' + esc(d.reference) + '</div>' +
            '</td></tr>' +
          '</table>' +

          // Details
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">' +
            detailRow("When", esc(d.slotLabel), false) +
            detailRow("What", esc(d.items), false) +
            detailRow("Total", esc(d.total) + " &middot; " + esc(d.payment), false) +
            detailRow("Where", esc(d.address), !d.access) +
            (d.access ? detailRow("Access", esc(d.access), true) : "") +
          '</table>' +

          // Asks for parking, pets and gate codes when the booking has no notes
          (d.askExtras ? '<div style="margin-top:20px;">' + extrasAskHtml_() + '</div>' : '') +

          // Prep checklist — added after a customer asked what they should
          // do before the visit to make sure everything's accessible. The
          // "strip the bedding" line only shows when the booking actually
          // includes a mattress, checked against the plain-text items list
          // built client-side (e.g. "1x Mattress (single/double): £40").
          prepChecklistHtml(d.items) +

        '</td></tr>' +

        // CTA
        '<tr><td style="background:' + SURFACE + ';border-left:1px solid ' + LINE + ';border-right:1px solid ' + LINE + ';padding:20px 28px 36px;text-align:center;">' +
          (d.manageUrl ? changeCtaHtml_(d.manageUrl, d.waLink) :
          '<p style="margin:0 0 16px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Need to change anything? Just reply to this email, or message us directly:</p>' +
          '<a href="' + d.waLink + '" style="display:inline-block;background:' + TEAL + ';color:' + ON_INK + ';font-family:\'Public Sans\',' + SANS + ';font-weight:700;font-size:14.5px;text-decoration:none;padding:12px 24px;border-radius:3px;">WhatsApp us</a>') +
        '</td></tr>' +

        // Right to cancel and the cancellation form (homeowners only)
        (d.cancel ? cancellationHtml_(d.cancel, d.reference, { SANS: SANS, INK: INK, SLATE: SLATE, LINE: LINE, PAPER: PAPER, SURFACE: SURFACE, TEAL_DEEP: TEAL_DEEP }, d.formAttached, !!d.manageUrl) : '') +

        // Footer
        '<tr><td style="background:' + PAPER + ';border:1px solid ' + LINE + ';border-top:none;padding:24px 28px;text-align:center;">' +
          '<div style="font-family:' + SANS + ';font-weight:800;font-size:13px;letter-spacing:0.02em;text-transform:uppercase;color:' + INK_SOFT + ';margin-bottom:6px;">EasyClean Somerset</div>' +
          '<p style="margin:0 0 10px;font-family:' + SANS + ';font-size:12px;line-height:1.6;color:' + SLATE + ';">Carpet, upholstery &amp; mattress cleaning across Bath, Bristol &amp; mid Somerset</p>' +
          '<a href="https://easycleansomerset.co.uk" style="font-family:' + SANS + ';font-size:12px;font-weight:700;color:' + TEAL_DEEP + ';text-decoration:none;">easycleansomerset.co.uk</a>' +
          '<span style="font-family:' + SANS + ';font-size:12px;color:' + LINE + ';padding:0 8px;">&middot;</span>' +
          '<a href="https://easycleansomerset.co.uk/terms.html" style="font-family:' + SANS + ';font-size:12px;font-weight:700;color:' + TEAL_DEEP + ';text-decoration:none;">Terms &amp; Conditions</a>' +
        '</td></tr>' +

        // Thin bottom accent bar — bookends the top one
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +

      '</table>' +
      traderHtml_() +
    '</div>'
  );
}

// ============================================================
// Morning-of appointment reminders
// ============================================================

/**
 * Run this ONCE, the same way as setUpAutoRefresh/setUpCustomerSheet above:
 * pick "setUpDailyReminders" from the function dropdown and click Run.
 * Creates a trigger that runs sendDayOfReminders() once a day, in the
 * REMINDER_HOUR-to-(REMINDER_HOUR+1) window (Apps Script time triggers run
 * sometime within the hour you give them, not at an exact minute — fine for
 * a morning reminder). Safe to run again later; it clears any previous
 * version of this trigger first so you never end up with two.
 */
function setUpDailyReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sendDayOfReminders") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sendDayOfReminders").timeBased().everyDays(1).atHour(REMINDER_HOUR).create();
}

// Runs once a day (see setUpDailyReminders above). Looks at every calendar
// event booked in for today, matches each one back to its full details in
// the customer sheet by reference, and emails that customer a reminder.
// Each booking is handled in its own try/catch — one bad row (or a customer
// whose email somehow didn't save) should never stop the rest of today's
// reminders from going out.
// "Booking time" as readable text. Google Sheets sometimes turns the label
// written at booking into a real date, which would print as a long
// computer-style date in an email, so format it when that has happened.
function bookingTimeText(v) {
  var val = v["Booking time"];
  if (val instanceof Date && !isNaN(val.getTime())) return fmtWhen(val);
  return String(val || "");
}

function sendDayOfReminders() {
  // The one daily trigger runs everything that happens each morning (no
  // extra setup needed): day-before reminders, the Monday unpaid digest,
  // today's reminders, the 2-day follow-ups, the monthly figures email (on
  // the 1st), and last of all the health check, so it can report anything
  // that failed this morning. Each part is separate so one failing never
  // stops the others.
  try { sendDayBeforeReminders(); } catch (err) { noteProblem_("Day-before reminders failed", err); }
  try {
    if (Utilities.formatDate(new Date(), TIMEZONE, "u") === "1") sendUnpaidDigest();
  } catch (err) { noteProblem_("Unpaid invoices email failed", err); }
  try { sendTodaysReminders_(); } catch (err) { noteProblem_("Morning reminders failed", err); }
  try { sendFollowUps_(); } catch (err) { noteProblem_("2-day follow-up emails failed", err); }
  try { sendMonthlyFigures_(); } catch (err) { noteProblem_("Monthly figures email failed", err); }
  try { dailyHealthCheck_(); } catch (err) { console.error("Health check failed: " + err); }
}

// Today's bookings, with their real start time from the calendar (so a
// job dragged to a new time shows the new time). Skips cancelled and
// completed ones, and anything already reminded today.
function sendTodaysReminders_() {
  var sheet = null, header = null;
  getBookingReferencesForDay(new Date()).forEach(function (item) {
    try {
      var row = findBookingRow(item.ref);
      if (!row || !row.values.Email) return; // nothing to send to, skip
      var v = row.values;
      if (v["Cancelled at"] || v["Completed at"]) return;
      if (v["Day-of reminder sent"] instanceof Date &&
          Utilities.formatDate(v["Day-of reminder sent"], TIMEZONE, "yyyy-MM-dd") === Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd")) return;
      sendReminderEmail(v, item.start);
      if (!sheet) { sheet = getCustomerSheet(); header = ensureColumns(sheet, ["Day-of reminder sent"]); }
      sheet.getRange(row.rowIndex, header.indexOf("Day-of reminder sent") + 1).setValue(new Date());
    } catch (err) {
      noteProblem_("Morning reminder failed for " + item.ref, err);
    }
  });
}

function getBookingReferencesForDay(day) {
  var refs = [];
  CalendarApp.getDefaultCalendar().getEventsForDay(day).forEach(function (ev) {
    var ref = referenceFromEvent(ev);
    if (ref) refs.push({ ref: ref, start: ev.getStartTime ? ev.getStartTime() : null });
  });
  return refs;
}

// Day-before reminder: prep checklist, and an access nudge for agent
// bookings where the agent is arranging access. Skips bookings made in the
// last 18 hours (their confirmation email is still fresh), cancelled or
// completed ones, and anything already reminded (so a re-run never doubles up).
function sendDayBeforeReminders() {
  var tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  var sheet = null, header = null;
  getBookingReferencesForDay(tomorrow).forEach(function (item) {
    try {
      var row = findBookingRow(item.ref);
      if (!row) return;
      var v = row.values;
      if (!v.Email || v["Cancelled at"] || v["Completed at"] || v["Day-before reminder sent"]) return;
      if (v.Timestamp instanceof Date && Date.now() - v.Timestamp.getTime() < 18 * 60 * 60 * 1000) return;
      sendDayBeforeEmail(v, item.start);
      if (!sheet) { sheet = getCustomerSheet(); header = ensureColumns(sheet, ["Day-before reminder sent"]); }
      sheet.getRange(row.rowIndex, header.indexOf("Day-before reminder sent") + 1).setValue(new Date());
    } catch (err) {
      noteProblem_("Day-before reminder failed for " + item.ref, err);
    }
  });
}

function sendDayBeforeEmail(v, start) {
  var isAgent = v.Channel === "Agent/Landlord";
  var name = isAgent ? (v.Name || v["Business name"]) : v.Name;
  var accessNudge = isAgent && /^Agent arranging/.test(String(v.Access || ""));
  var when = start ? fmtWhen(start) : bookingTimeText(v);
  var waLink = "https://wa.me/" + WHATSAPP_NUMBER + "?text=" +
    encodeURIComponent("Hi EasyClean Somerset, about tomorrow's booking. Ref: " + v.Reference);
  var textBody = "Hi " + name + ",\n\n" +
    "Just a reminder, we're booked in for tomorrow.\n\n" +
    "When: " + when + "\nWhat: " + v.Items + "\nWhere: " + v.Address + "\nReference: " + v.Reference + "\n\n" +
    (accessNudge ? "Access: you chose to arrange access with us. If you haven't told us yet how we'll get in (keys, a lockbox code or the tenant's details), please reply or WhatsApp us today.\n\n" : "") +
    (needsExtrasAsk_(v.Notes) ? EXTRAS_ASK_TEXT + "\n\n" : "") +
    "Getting ready: clear small items off the floor, keep pets in another room, and clear a path from the door. A plug socket and water tap nearby helps." +
    (String(v.Items).indexOf("Mattress") !== -1 ? " Please strip the bedding beforehand." : "") +
    "\n\n" + changeText_(manageLink_(v[MANAGE_TOKEN_COLUMN]), waLink, "Need to change anything? Reply to this email or WhatsApp us: ") + "\n\nSee you tomorrow,\nEasyClean Somerset";
  sendCustomerEmail_(v.Email, "Reminder: we're cleaning for you tomorrow", textBody, {
    htmlBody: buildReminderEmailHtml({
      dayBefore: true, accessNudge: accessNudge, askExtras: needsExtrasAsk_(v.Notes),
      name: name, slotLabel: when, items: v.Items, total: v.Total, payment: v["Payment method"],
      address: v.Address, reference: v.Reference, waLink: waLink,
      access: isAgent ? v.Access : "",
      manageUrl: manageLink_(v[MANAGE_TOKEN_COLUMN])
    }),
    name: "EasyClean Somerset"
  });
}

function sendReminderEmail(v, start) {
  var when = start ? fmtWhen(start) : bookingTimeText(v);
  var waLink = "https://wa.me/" + WHATSAPP_NUMBER + "?text=" +
    encodeURIComponent("Hi EasyClean Somerset, about today's booking. Ref: " + v.Reference);
  var textBody = "Hi " + v.Name + ",\n\n" +
    "Quick reminder, we've got you booked in for today.\n\n" +
    "When: " + when + "\n" +
    "What: " + v.Items + "\n" +
    "Total: " + v.Total + " (" + v["Payment method"] + ")\n" +
    "Where: " + v.Address + "\n\n" +
    "Reference: " + v.Reference + "\n\n" +
    // No Change or cancel button on the day itself: just reply or WhatsApp.
    "Need to change anything? Just reply to this email or WhatsApp us: " + waLink + "\n\n" +
    "See you soon,\nEasyClean Somerset";

  sendCustomerEmail_(v.Email, "Reminder: we're cleaning for you today", textBody, {
    htmlBody: buildReminderEmailHtml({
      name: v.Name,
      slotLabel: when,
      items: v.Items,
      total: v.Total,
      payment: v["Payment method"],
      address: v.Address,
      reference: v.Reference,
      waLink: waLink,
      manageUrl: ""
    }),
    name: "EasyClean Somerset"
  });
}

// "Getting ready for your visit" box, shared by the confirmation email and
// the day-before reminder. The "strip the bedding" line only shows when the
// booking includes a mattress.
function prepChecklistHtml(items) {
  var INK_SOFT = "#2A3D46", PAPER = "#F5F7F6", LINE = "#DCE3E2", SLATE = "#5C6F73";
  var SANS = "Arial,Helvetica,sans-serif";
  return '<div style="border:1px solid ' + LINE + ';border-radius:4px;padding:18px 20px;margin:24px 0 4px;background:' + PAPER + ';">' +
    '<div style="font-family:' + SANS + ';font-weight:bold;font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:' + SLATE + ';margin-bottom:10px;">Getting ready for your visit</div>' +
    '<ul style="margin:0;padding-left:18px;font-family:' + SANS + ';font-size:13.5px;line-height:1.6;color:' + INK_SOFT + ';">' +
      '<li style="margin-bottom:6px;">Clear the floor of small items, toys, shoes, cables, so nothing gets caught up or damaged while we work.</li>' +
      '<li style="margin-bottom:6px;">Keep pets in another room during the visit, safer for them and easier for us.</li>' +
      '<li style="margin-bottom:6px;">Clear a path from the door to the room, and a nearby parking space if you can. A plug socket and water tap close by helps too.</li>' +
      (String(items).indexOf("Mattress") !== -1 ?
        '<li style="margin-bottom:6px;">Strip the bedding beforehand, sheets, protector, pillowcases.</li>' : '') +
      '<li style="margin-bottom:6px;">Carpets and upholstery need a few hours to dry, worth planning around before we arrive.</li>' +
      '<li style="margin-bottom:0;">Got a specific stain or area you&#8217;d like extra attention on? Reply to this email or message us and we&#8217;ll come prepared.</li>' +
    '</ul>' +
  '</div>';
}

// Same visual language as buildConfirmationEmailHtml (same colours, same
// table-based inline-style approach for the same reason: Gmail/Outlook
// reliability), just a shorter body. Used for the morning-of reminder and,
// with d.dayBefore, the day-before reminder (adds the prep checklist and,
// for "agent arranging access" bookings, an access nudge).
function buildReminderEmailHtml(d) {
  var esc = escHtml;
  var INK = "#12232B", TEAL = "#0E7C86", TEAL_DEEP = "#0A5960", PAPER = "#F5F7F6";
  var SURFACE = "#FFFFFF", LINE = "#DCE3E2", SLATE = "#5C6F73", ON_INK = "#F5F7F6";
  var SANS = "Arial,Helvetica,sans-serif";
  var LOGO_URL = SITE_URL + "/apple-touch-icon.png";

  function detailRow(label, value, isLast) {
    var borderStyle = isLast ? "" : "border-bottom:1px solid " + LINE + ";";
    return (
      '<tr><td style="padding:14px 0;' + borderStyle + '">' +
        '<div style="font-family:' + SANS + ';font-weight:bold;font-size:10.5px;letter-spacing:0.12em;text-transform:uppercase;color:' + SLATE + ';margin-bottom:5px;">' + label + '</div>' +
        '<div style="font-family:' + SANS + ';font-size:15px;font-weight:600;color:' + INK + ';line-height:1.5;">' + value + '</div>' +
      '</td></tr>'
    );
  }

  return (
    '<div style="background:' + PAPER + ';padding:40px 16px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
        '<tr><td style="background:' + INK + ';padding:30px 28px 26px;text-align:center;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">' +
            '<tr>' +
              '<td style="width:40px;height:40px;vertical-align:middle;">' +
                '<img src="' + LOGO_URL + '" width="40" height="40" alt="EasyClean Somerset" style="display:block;width:40px;height:40px;" />' +
              '</td>' +
              '<td style="width:14px;font-size:14px;">&nbsp;</td>' +
              '<td style="text-align:left;vertical-align:middle;">' +
                '<span style="font-family:' + SANS + ';font-weight:800;font-size:19px;letter-spacing:0.01em;text-transform:uppercase;color:' + ON_INK + ';">Easy<span style="color:' + TEAL + ';">Clean</span> Somerset</span>' +
              '</td>' +
            '</tr>' +
          '</table>' +
        '</td></tr>' +
        '<tr><td style="background:' + SURFACE + ';border-left:1px solid ' + LINE + ';border-right:1px solid ' + LINE + ';padding:32px 28px 8px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="background:' + TEAL + ';padding:5px 12px;border-radius:20px;">' +
            '<span style="font-family:' + SANS + ';font-weight:bold;font-size:11.5px;letter-spacing:0.08em;text-transform:uppercase;color:' + ON_INK + ';">' + (d.dayBefore ? "Tomorrow&#8217;s Booking" : "Today&#8217;s Booking") + '</span>' +
          '</td></tr></table>' +
          '<p style="margin:0 0 6px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Hi ' + esc(d.name) + ',</p>' +
          '<h1 style="margin:0 0 18px;font-family:' + SANS + ';font-weight:800;font-size:24px;letter-spacing:-0.01em;color:' + INK + ';">' + (d.dayBefore ? "See you tomorrow" : "We&#8217;re cleaning for you today") + '</h1>' +
          (d.accessNudge ? '<p style="margin:0 0 18px;padding:12px 14px;border-left:3px solid #B5461E;background:' + PAPER + ';font-family:' + SANS + ';font-size:14px;line-height:1.55;color:' + INK + ';"><strong>Access:</strong> you chose to arrange access with us. If you haven&#8217;t told us yet how we&#8217;ll get in (keys to collect, a lockbox code or the tenant&#8217;s details), please reply or WhatsApp us today.</p>' : '') +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">' +
            detailRow("When", esc(d.slotLabel), false) +
            detailRow("What", esc(d.items), false) +
            detailRow("Total", esc(d.total) + " &middot; " + esc(d.payment), false) +
            detailRow("Where", esc(d.address), !d.access) +
            (d.access ? detailRow("Access", esc(d.access), true) : "") +
          '</table>' +
          // Asks for parking, pets and gate codes when the booking has no notes
          (d.dayBefore && d.askExtras ? '<div style="margin-top:20px;">' + extrasAskHtml_() + '</div>' : '') +
          (d.dayBefore ? prepChecklistHtml(d.items) : '') +
        '</td></tr>' +
        '<tr><td style="background:' + SURFACE + ';border-left:1px solid ' + LINE + ';border-right:1px solid ' + LINE + ';padding:20px 28px 32px;text-align:center;">' +
          (d.manageUrl ? changeCtaHtml_(d.manageUrl, d.waLink) :
          '<p style="margin:0 0 16px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Need to change anything? Just reply to this email, or message us directly:</p>' +
          '<a href="' + d.waLink + '" style="display:inline-block;background:' + TEAL + ';color:' + ON_INK + ';font-family:\'Public Sans\',' + SANS + ';font-weight:700;font-size:14.5px;text-decoration:none;padding:12px 24px;border-radius:3px;">WhatsApp us</a>') +
        '</td></tr>' +
        '<tr><td style="background:' + PAPER + ';border:1px solid ' + LINE + ';border-top:none;padding:22px 28px;text-align:center;">' +
          '<div style="font-family:' + SANS + ';font-weight:800;font-size:12.5px;letter-spacing:0.02em;text-transform:uppercase;color:' + SLATE + ';">EasyClean Somerset &middot; Ref ' + esc(d.reference) + '</div>' +
        '</td></tr>' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
      '</table>' +
      traderHtml_() +
    '</div>'
  );
}

// ============================================================
// On-site signature capture, thank-you email, invoice
// ============================================================

// ---- Customer-facing signing link (public) ----
// What job-complete.html shows a customer who's been sent a link to sign
// off their own job. Looked up by the booking's secret token only; the
// short EC- reference is never accepted here, so there's nothing to guess.
// Deliberately minimal: no phone numbers or email addresses.
function getPublicJob(token) {
  if (!isPlausibleToken(token)) return { ok: false, error: "not_found" };
  var row = findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  var v = row.values;
  return {
    ok: true,
    reference: v.Reference,
    name: v.Channel === "Agent/Landlord" ? v["Business name"] : v.Name,
    address: v.Address,
    items: v.Items,
    total: v.Total,
    alreadyCompleted: !!v["Completed at"],
    cancelled: !!v["Cancelled at"]
  };
}

// A customer signing their own job from the link. Signature required: the
// "complete without a signature" option is Niall's alone, in the admin app.
function completeJobPublic(data) {
  if (!isPlausibleToken(data.token)) return { ok: false, error: "not_found" };
  var sig = String(data.signature || "");
  if (sig.indexOf("data:image/png;base64,") !== 0 || sig.length > 1500000) {
    return { ok: false, error: "missing_fields" };
  }
  return completeJob({ token: data.token, signature: sig });
}

function toWhatsAppNumber(ukPhone) {
  if (!ukPhone) return "";
  var digits = phoneText(ukPhone).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.charAt(0) === "0") digits = "44" + digits.slice(1);
  else if (digits.length === 10) digits = "44" + digits; // UK number stored without its 0
  return digits;
}

// The WhatsApp equivalent needs no backend call (no paid WhatsApp API): the
// admin app builds a wa.me link Niall taps and sends himself.
// Emails the customer (or, for agent bookings, whoever booked) a link to
// sign the job off themselves. Admin app only.
function sendSigningLinkForRow(row) {
  var v = row.values;
  if (v["Completed at"]) return { ok: false, error: "already_completed" };
  if (!v.Email) return { ok: false, error: "no_email" };
  var customerName = v.Channel === "Agent/Landlord" ? (v.Name || v["Business name"]) : v.Name;
  var link = publicSigningLink(v["Job token"]);
  var textBody = "Hi " + customerName + ",\n\n" +
    "Could you confirm today's clean is all done? Tap the link below to have a look and pop your signature on it:\n\n" +
    link + "\n\n" +
    "Thanks,\nEasyClean Somerset";

  sendCustomerEmail_(v.Email, "Please confirm your clean is complete", textBody, {
    htmlBody: buildSigningLinkEmailHtml({ name: customerName, link: link, reference: v.Reference }),
    name: "EasyClean Somerset"
  });
  return { ok: true };
}

function buildSigningLinkEmailHtml(d) {
  var esc = escHtml;
  var INK = "#12232B", TEAL = "#0E7C86", PAPER = "#F5F7F6", SURFACE = "#FFFFFF";
  var LINE = "#DCE3E2", SLATE = "#5C6F73", ON_INK = "#F5F7F6";
  var SANS = "Arial,Helvetica,sans-serif";
  var LOGO_URL = SITE_URL + "/apple-touch-icon.png";

  return (
    '<div style="background:' + PAPER + ';padding:40px 16px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
        '<tr><td style="background:' + INK + ';padding:30px 28px 26px;text-align:center;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">' +
            '<tr>' +
              '<td style="width:40px;height:40px;vertical-align:middle;">' +
                '<img src="' + LOGO_URL + '" width="40" height="40" alt="EasyClean Somerset" style="display:block;width:40px;height:40px;" />' +
              '</td>' +
              '<td style="width:14px;font-size:14px;">&nbsp;</td>' +
              '<td style="text-align:left;vertical-align:middle;">' +
                '<span style="font-family:' + SANS + ';font-weight:800;font-size:19px;letter-spacing:0.01em;text-transform:uppercase;color:' + ON_INK + ';">Easy<span style="color:' + TEAL + ';">Clean</span> Somerset</span>' +
              '</td>' +
            '</tr>' +
          '</table>' +
        '</td></tr>' +
        '<tr><td style="background:' + SURFACE + ';border-left:1px solid ' + LINE + ';border-right:1px solid ' + LINE + ';padding:32px 28px 30px;text-align:center;">' +
          '<p style="margin:0 0 6px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Hi ' + esc(d.name) + ',</p>' +
          '<h1 style="margin:0 0 18px;font-family:' + SANS + ';font-weight:800;font-size:24px;letter-spacing:-0.01em;color:' + INK + ';">Could you confirm today&#8217;s clean is done?</h1>' +
          '<p style="margin:0 0 24px;font-family:' + SANS + ';font-size:14.5px;line-height:1.6;color:' + SLATE + ';">Tap the button below to have a quick look and pop your signature on it, it only takes a moment.</p>' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="background:' + TEAL + ';border-radius:3px;">' +
            '<a href="' + d.link + '" style="display:inline-block;padding:13px 26px;font-family:\'Public Sans\',' + SANS + ';font-weight:700;font-size:14.5px;color:' + ON_INK + ';text-decoration:none;">Confirm the job&#8217;s done</a>' +
          '</td></tr></table>' +
        '</td></tr>' +
        '<tr><td style="background:' + PAPER + ';border:1px solid ' + LINE + ';border-top:none;padding:22px 28px;text-align:center;">' +
          '<div style="font-family:' + SANS + ';font-weight:800;font-size:12.5px;letter-spacing:0.02em;text-transform:uppercase;color:' + SLATE + ';">EasyClean Somerset &middot; Ref ' + esc(d.reference) + '</div>' +
        '</td></tr>' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
      '</table>' +
      traderHtml_() +
    '</div>'
  );
}

// Called by job-complete.html once a customer's signed on the pad (or
// Niall's used the "customer not available to sign" fallback). Saves the
// signature (when there is one), marks the sheet row done, generates a
// numbered invoice PDF and emails it to the customer along with a
// thank-you + review request. Guarded against being run twice for the same
// booking (double-tap, page reloaded after already submitting) — the
// second call just reports back that it's already done rather than
// sending a second thank-you email and burning another invoice number.
// Internal/admin entry point: finds the booking by its job token (always
// unique, never the guessable EC- reference). The public website can only
// reach this through completeJobPublic() below.
function completeJob(data) {
  if (!data.token || (!data.signature && !data.noSignature)) {
    return { ok: false, error: "missing_fields" };
  }
  // One completion at a time, so a customer signing a remote link at the
  // same moment Niall marks the job done can't produce two invoices.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return completeJobLocked_(data);
  } finally {
    lock.releaseLock();
  }
}

function completeJobLocked_(data) {
  var row = findBookingByToken(data.token);
  if (!row) return { ok: false, error: "not_found" };
  if (row.values["Completed at"]) {
    return { ok: true, alreadyCompleted: true };
  }
  if (row.values["Cancelled at"]) {
    return { ok: false, error: "cancelled" };
  }
  var ref = row.values.Reference;

  var signatureUrl = "";
  if (data.signature) {
    try {
      signatureUrl = saveSignature(ref, data.signature);
    } catch (err) {
      // A signature that fails to save shouldn't stop the job being marked
      // done and the customer being thanked — logged so it's visible in the
      // execution log, but not fatal to the rest of this function.
      noteProblem_("Saving the signature failed for " + ref, err);
    }
  } else {
    // No-signature path (empty property, key left out, customer declined).
    // Recorded plainly in the same column a real signature link would sit
    // in, rather than leaving it blank and indistinguishable from the
    // storage silently failing.
    signatureUrl = "No signature — " + (data.reason || "customer not available");
  }

  var invoiceNumber = nextInvoiceNumber(true); // already holding the script lock
  var completedAt = new Date();
  var v = row.values;
  // The day the clean was done, which is earlier than today when the
  // customer signs a link later (FRE-203).
  var jobDate = jobDateFor_(v, completedAt);
  var inv = buildInvoiceContext(v, invoiceNumber, completedAt);
  inv.jobDate = jobDate;

  // Build each PDF once, then use the same file both for the Drive copy and
  // the email attachment, so what's on file is exactly what was sent.
  var invoiceBlob = null, completionBlob = null;
  try {
    invoiceBlob = buildInvoicePdfBlob(v, inv);
  } catch (err) {
    noteProblem_("Invoice PDF failed for " + ref, err);
    notifyOwner("Invoice PDF failed for " + ref, "The job is marked complete, but its invoice PDF couldn't be created (" + err + "), so the customer's email went without it. Send the invoice by hand.");
  }
  if (data.signature) {
    var photos = null;
    try {
      photos = photosForPdf_(v);
    } catch (err) {
      noteProblem_("Reading the job photos for the completion PDF failed for " + ref, err);
    }
    try {
      completionBlob = buildJobCompletionPdfBlob(v, invoiceNumber, completedAt, data.signature, photos, jobDate);
    } catch (err) {
      noteProblem_("Job completion PDF failed for " + ref, err);
      if (photos) {
        // Try again without the photos, so the customer still gets the signed confirmation.
        try {
          completionBlob = buildJobCompletionPdfBlob(v, invoiceNumber, completedAt, data.signature, null, jobDate);
        } catch (err2) {
          noteProblem_("Job completion PDF failed again, without photos, for " + ref, err2);
        }
      }
    }
  }

  // Drive copies. A failed save is logged, never fatal: the email below
  // still carries both documents, and the sheet says the save didn't happen
  // rather than leaving a blank that looks like nothing was ever generated.
  var invoiceUrl = "", completionUrl = "";
  if (invoiceBlob) {
    try {
      invoiceUrl = saveDocumentToDrive(INVOICES_FOLDER_NAME, completedAt, invoiceBlob);
    } catch (err) {
      invoiceUrl = "Not saved to Drive (see execution log)";
      noteProblem_("Saving the invoice to Drive failed for " + ref, err);
      notifyOwner("Invoice not saved to Drive for " + ref, "The invoice was emailed, but the Drive copy failed (" + err + "). The emailed copy is in your Sent folder.");
    }
  }
  if (completionBlob) {
    try {
      completionUrl = saveDocumentToDrive(COMPLETIONS_FOLDER_NAME, completedAt, completionBlob);
    } catch (err) {
      completionUrl = "Not saved to Drive (see execution log)";
      noteProblem_("Saving the completion PDF to Drive failed for " + ref, err);
    }
  }

  var sheet = getCustomerSheet();
  var headerRow = ensureColumns(sheet, COMPLETION_COLUMNS);
  var writes = {
    "Completed at": completedAt,
    "Signature link": signatureUrl,
    "Invoice number": invoiceNumber,
    "Invoice PDF": invoiceUrl,
    "Completion PDF": completionUrl,
    "Payment due": inv.paymentDue ? inv.dueDate : "",
    // Cash/on-the-day payments are paid at completion. Agent bank transfers
    // stay blank until Niall fills this in when the money arrives, which is
    // what makes "who still owes me" a simple filter on this column.
    // Paid on the day of the clean (cash or no charge).
    "Paid on": inv.paymentDue ? "" : jobDate
  };
  Object.keys(writes).forEach(function (header) {
    sheet.getRange(row.rowIndex, headerRow.indexOf(header) + 1).setValue(writes[header]);
  });

  // Time on job (FRE-194): a job that was started but never finished is
  // finished at sign-off, if that's within a working day of the start.
  try {
    var startedAt = v["Started at"] instanceof Date ? v["Started at"] : null;
    if (startedAt && !(v["Finished at"] instanceof Date) &&
        completedAt.getTime() - startedAt.getTime() <= AUTO_FINISH_MAX_MINS * 60000) {
      var timingHeader = ensureColumns(sheet, TIMING_COLUMNS);
      setRowValues_(sheet, row.rowIndex, timingHeader, {
        "Finished at": completedAt,
        "Actual mins": Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 60000))
      });
    }
  } catch (err) {
    noteProblem_("Recording the time on job failed for " + ref, err);
  }
  // Income (FRE-187): what this job adds to the books.
  try {
    writeIncome_(sheet, row.rowIndex, jobIncomeAmount_(v));
  } catch (err) {
    noteProblem_("Recording the income failed for " + ref, err);
  }

  try {
    var attachments = [invoiceBlob, completionBlob].filter(function (b) { return b; });
    // Bookings taken by phone may have no email; the invoice is still saved to Drive.
    if (v.Email) sendThankYouEmail(v, inv, attachments);
  } catch (err) {
    // Same principle as everywhere else in this file: the job's already
    // recorded as done and invoiced above, which is what actually matters —
    // a failed email shouldn't undo that or fail this response.
    noteProblem_("Thank-you and invoice email failed for " + ref, err);
    notifyOwner("Invoice email failed for " + ref, "The job is marked complete and invoiced, but the email to the customer didn't send (" + err + "). Send them the invoice from the Drive copy.");
  }

  return { ok: true, invoiceNumber: invoiceNumber };
}

// Adds any of `names` missing from the sheet's header row to the end of it,
// and returns the (possibly extended) header row. Every read and write in
// this file goes by header name, so appending at the end is always safe.
function ensureColumns(sheet, names) {
  var lastCol = sheet.getLastColumn();
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  names.forEach(function (name) {
    if (headerRow.indexOf(name) === -1 && renameOldColumn_(sheet, headerRow, name)) return;
    if (headerRow.indexOf(name) === -1) {
      sheet.getRange(1, headerRow.length + 1).setValue(name);
      headerRow.push(name);
    }
  });
  return headerRow;
}

// Columns that have been renamed: new name -> { old name, old value -> new value }.
var RENAMED_COLUMNS = {};
RENAMED_COLUMNS[EARLY_START_COLUMN] = { from: EARLY_START_OLD_COLUMN, values: EARLY_START_OLD_VALUES };

// If `name` is a renamed column and the sheet still has it under its old
// name, renames that header cell and rewords its old values, so old and new
// rows sit in one column. Returns true if it renamed one.
function renameOldColumn_(sheet, headerRow, name) {
  var rename = RENAMED_COLUMNS[name];
  if (!rename) return false;
  var col = headerRow.indexOf(rename.from);
  if (col === -1) return false;
  sheet.getRange(1, col + 1).setValue(name);
  headerRow[col] = name;
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var range = sheet.getRange(2, col + 1, lastRow - 1, 1);
    var changed = false;
    var values = range.getValues().map(function (r) {
      var next = rename.values[String(r[0])];
      if (next === undefined) return [r[0]];
      changed = true;
      return [next];
    });
    if (changed) range.setValues(values);
  }
  return true;
}

// Everything the invoice PDF and the email need to know about which kind of
// invoice this is. Two kinds:
//   - Consumer, or an agent who paid cash on the day: a receipt, marked paid.
//   - Agent paying by bank transfer: payment due in AGENT_PAYMENT_TERMS_DAYS,
//     billed to the agency's office address (from the Agencies tab), with
//     bank details and a payment reference.
function buildInvoiceContext(v, invoiceNumber, completedAt) {
  var isAgent = v.Channel === "Agent/Landlord";
  // Homeowners paying by bank transfer pay on completion, so their invoice
  // is a payment-due invoice too (due the same day), with bank details, and
  // stays in the admin app's Unpaid list until marked paid.
  var consumerBankTransfer = !isAgent && /bank transfer/i.test(String(v["Payment method"] || ""));
  var paymentDue = (isAgent && v["Payment method"] !== "Cash") || consumerBankTransfer;
  var ctx = {
    isAgent: isAgent,
    paymentDue: paymentDue,
    dueOnCompletion: consumerBankTransfer,
    invoiceNumber: invoiceNumber,
    invoiceNo: formatInvoiceNo(invoiceNumber),
    completedAt: completedAt,
    billToName: isAgent ? v["Business name"] : v.Name,
    billToAddress: isAgent ? "" : v.Address,
    accountsEmail: ""
  };
  if (isAgent) {
    try {
      var agency = getAgencyBilling(v["Business name"]);
      // The Agencies tab's spelling wins over however the agent typed their
      // name on the form, so every invoice to one agency reads the same.
      if (agency.businessName) ctx.billToName = agency.businessName;
      ctx.billToAddress = agency.billingAddress;
      ctx.accountsEmail = agency.accountsEmail;
    } catch (err) {
      noteProblem_("Agencies tab lookup failed for " + v.Reference, err);
    }
  }
  if (paymentDue) {
    ctx.dueDate = consumerBankTransfer
      ? new Date(completedAt.getTime())
      : new Date(completedAt.getTime() + AGENT_PAYMENT_TERMS_DAYS * 24 * 60 * 60 * 1000);
    ctx.bank = getBankDetails();
  }
  return ctx;
}

// Late payment on business invoices (FRE-195). The Late Payment of
// Commercial Debts (Interest) Act 1998 applies to business-to-business
// invoices: statutory interest at 8% over the Bank of England base rate, plus
// fixed compensation by size of debt (GOV.UK, checked 9 Oct 2026). Our terms
// set no other rate, so the statutory one applies. The base rate isn't
// written as a number, since it changes.
function lateFeeCompensation_(amount) {
  if (!(amount > 0)) return 40;
  if (amount >= 10000) return 100;
  if (amount >= 1000) return 70;
  return 40;
}

function latePaymentText_(totalText) {
  var amount = parseMoney_(totalText);
  return "If this invoice isn't paid by the due date, we may charge statutory interest at 8% above the Bank of England base rate, " +
    "plus \u00a3" + lateFeeCompensation_(amount) + " fixed compensation, under the Late Payment of Commercial Debts (Interest) Act 1998.";
}

// Invoice numbers are stored as plain numbers in the sheet (1001, 1002...)
// and shown on documents and used as the bank payment reference as INV-1001.
function formatInvoiceNo(n) {
  return "INV-" + n;
}

function getBankDetails() {
  var props = PropertiesService.getScriptProperties();
  var bank = {
    accountName: props.getProperty(BANK_PROPERTY_KEYS.accountName) || "",
    sortCode: props.getProperty(BANK_PROPERTY_KEYS.sortCode) || "",
    accountNumber: props.getProperty(BANK_PROPERTY_KEYS.accountNumber) || ""
  };
  bank.complete = !!(bank.accountName && bank.sortCode && bank.accountNumber);
  return bank;
}

// ---- Agencies tab: matching agency names (FRE-195) ----
// Agents type their business name on the booking form, so one agency can
// arrive under several spellings. Three layers:
//   1. Names that differ only in capitals, spaces, punctuation, "&" or
//      "and", "The" or "Ltd"/"Limited" are the same agency, automatically.
//   2. The "Same as" column links one row to another, for spellings Niall
//      confirms are the same ("Andrews Property" -> "Andrews").
//   3. A new name that looks like an existing one (same name once words like
//      "Lettings" or "Property" are set aside) is never merged on its own;
//      the new-booking email points it out so Niall can fill in "Same as".

// "The Andrews & Co. Ltd" -> "andrews and co"
function agencyKey_(name) {
  var s = String(name || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[‘’'`.,()\-\/]/g, " ")
    .replace(/\s+/g, " ").trim();
  s = s.replace(/^the /, "");
  s = s.replace(/ (ltd|limited|llp|plc)$/, "");
  return s.trim();
}

var AGENCY_GENERIC_WORDS = ["and", "the", "ltd", "limited", "llp", "plc", "co", "company", "uk", "group",
  "letting", "lettings", "let", "lets", "agent", "agents", "agency", "estate", "estates", "property",
  "properties", "homes", "residential", "sales", "management", "rentals"];

// The distinctive part of a name: "Andrews Property Lettings" -> "andrews".
function agencyCore_(name) {
  return agencyKey_(name).split(" ").filter(function (w) {
    return w && AGENCY_GENERIC_WORDS.indexOf(w) === -1;
  }).join(" ");
}

function agenciesTab_(create) {
  var sheetId = PropertiesService.getScriptProperties().getProperty(CUSTOMER_SHEET_PROPERTY_KEY);
  if (!sheetId) return null;
  var ss = SpreadsheetApp.openById(sheetId);
  var tab = ss.getSheetByName(AGENCIES_SHEET_NAME);
  if (!tab && create) {
    tab = ss.insertSheet(AGENCIES_SHEET_NAME);
    tab.getRange(1, 1, 1, AGENCIES_HEADERS.length).setValues([AGENCIES_HEADERS]).setFontWeight("bold");
    tab.setFrozenRows(1);
  }
  if (tab) ensureColumns(tab, AGENCIES_HEADERS);
  return tab;
}

function readAgencies_(tab) {
  var data = tab.getDataRange().getValues();
  var header = data[0];
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = rowToObject(header, data[i]);
    var name = String(r["Business name"] || "").trim();
    if (!name) continue;
    out.push({
      businessName: name,
      billingAddress: String(r["Billing address"] || "").trim(),
      accountsEmail: String(r["Accounts email"] || "").trim(),
      sameAs: String(r["Same as"] || "").trim()
    });
  }
  return out;
}

// Follows "Same as" (up to 3 links, so a loop can't hang it).
function resolveAgency_(list, row) {
  var seen = 0;
  while (row && row.sameAs && seen < 3) {
    var key = agencyKey_(row.sameAs);
    var next = null;
    for (var i = 0; i < list.length; i++) {
      if (agencyKey_(list[i].businessName) === key) { next = list[i]; break; }
    }
    if (!next || next === row) break;
    row = next;
    seen++;
  }
  return row;
}

// Finds an agency on the Agencies tab, adding it (details blank) if it isn't
// there, so Niall can see which ones need a billing address. Returns
// { businessName, billingAddress, accountsEmail, added, looksLike: [names] }.
// businessName etc. come from the "Same as" row when there is one.
function findOrAddAgency_(businessName) {
  var none = { businessName: "", billingAddress: "", accountsEmail: "", added: false, looksLike: [] };
  if (!String(businessName || "").trim()) return none;
  var tab = agenciesTab_(true);
  if (!tab) return none;
  var list = readAgencies_(tab);
  var key = agencyKey_(businessName);
  for (var i = 0; i < list.length; i++) {
    if (agencyKey_(list[i].businessName) === key) {
      var r = resolveAgency_(list, list[i]);
      return { businessName: r.businessName, billingAddress: r.billingAddress, accountsEmail: r.accountsEmail, added: false, looksLike: [] };
    }
  }
  var core = agencyCore_(businessName);
  var looksLike = [];
  if (core) {
    list.forEach(function (a) {
      if (a.sameAs) return; // point at the main row, not its other spellings
      if (agencyCore_(a.businessName) === core) looksLike.push(a.businessName);
    });
  }
  var header = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0];
  tab.appendRow(header.map(function (h) { return h === "Business name" ? String(businessName).trim() : ""; }));
  return { businessName: "", billingAddress: "", accountsEmail: "", added: true, looksLike: looksLike };
}

// Kept for the invoice and reminder code: { businessName, billingAddress, accountsEmail }.
function getAgencyBilling(businessName) {
  var a = findOrAddAgency_(businessName);
  return { businessName: a.businessName, billingAddress: a.billingAddress, accountsEmail: a.accountsEmail };
}

// The line for the new-booking email, or "" if the agency is all set.
function agencyAlertText_(businessName, check) {
  if (!check) return "";
  var name = String(businessName || "").trim();
  if (check.added && check.looksLike.length) {
    var other = check.looksLike[0];
    return "\"" + name + "\" is new in the Agencies tab, but looks like \"" + other + "\"" +
      (check.looksLike.length > 1 ? " (or " + check.looksLike.slice(1).map(function (n) { return "\"" + n + "\""; }).join(", ") + ")" : "") +
      ". If it's the same agency, type " + other + " in its Same as column, so the invoice uses " + other + "'s billing address.";
  }
  if (check.added) return "\"" + name + "\" is a new agency. Add its billing address in the Agencies tab before the job, so the invoice has it.";
  if (!check.billingAddress) return "There's no billing address for \"" + (check.businessName || name) + "\" in the Agencies tab yet. Add it before the job, so the invoice has it.";
  return "";
}

// Saves a generated PDF into <root folder>/<YYYY-MM>/ in Niall's Drive.
// Kept private (unlike signature images, which are link-shared so the sheet
// link opens from anywhere): these are only ever opened by Niall himself.
function saveDocumentToDrive(rootName, date, blob) {
  var root = getOrCreateFolder(rootName);
  var monthName = Utilities.formatDate(date, TIMEZONE, "yyyy-MM");
  var subs = root.getFoldersByName(monthName);
  var month = subs.hasNext() ? subs.next() : root.createFolder(monthName);
  return month.createFile(blob).getUrl();
}

function getOrCreateFolder(name) {
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

/**
 * Run this once (function dropdown next to Run) after adding the bank
 * details as Script Properties. Checks they're all there and shows the
 * agencies still missing a billing address. Prints to the execution log;
 * the account number is masked so the log never holds it in full.
 */
function checkInvoiceSettings() {
  var bank = getBankDetails();
  Logger.log("Bank account name: " + (bank.accountName || "MISSING (" + BANK_PROPERTY_KEYS.accountName + ")"));
  Logger.log("Sort code: " + (bank.sortCode || "MISSING (" + BANK_PROPERTY_KEYS.sortCode + ")"));
  Logger.log("Account number: " + (bank.accountNumber ? "****" + bank.accountNumber.slice(-4) : "MISSING (" + BANK_PROPERTY_KEYS.accountNumber + ")"));
  Logger.log(bank.complete ? "Bank details OK." : "Bank details incomplete: agent invoices will say to contact you for payment details.");
  var sheetId = PropertiesService.getScriptProperties().getProperty(CUSTOMER_SHEET_PROPERTY_KEY);
  var tab = sheetId ? SpreadsheetApp.openById(sheetId).getSheetByName(AGENCIES_SHEET_NAME) : null;
  if (!tab) { Logger.log("No Agencies tab yet. It's created the first time an agent job is completed."); return; }
  var data = tab.getDataRange().getValues();
  var header = data[0];
  var sameCol = header.indexOf("Same as");
  var missing = data.slice(1).filter(function (r) {
    return String(r[header.indexOf("Business name")] || "").trim() && !String(r[header.indexOf("Billing address")] || "").trim() &&
      !(sameCol !== -1 && String(r[sameCol] || "").trim());
  })
    .map(function (r) { return r[header.indexOf("Business name")]; });
  Logger.log(missing.length ? "Agencies missing a billing address: " + missing.join(", ") : "All agencies have a billing address.");
}

// Saves the signature (a base64 PNG data URL from the on-page canvas) into
// a Drive folder in Niall's own account, named after the booking reference
// so it's easy to find by hand later. Returns a shareable link, stored in
// the sheet's "Signature link" column.
function saveSignature(reference, dataUrl) {
  var base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), "image/png", reference + "-signature.png");
  var folder = getOrCreateFolder("EasyClean Somerset — Signatures");
  // Private to the business Google account (the signed completion PDF is
  // what customers get). The sheet link opens for Niall when signed in.
  return folder.createFile(blob).getUrl();
}

// Invoice numbers count up from 1001 and never repeat or reuse a number,
// even if a job is somehow completed twice or a run fails partway —
// LockService keeps two near-simultaneous completions (unlikely for a
// one-person operation, but cheap to guard against) from ever reading the
// same "next" number before either has saved it back.
var INVOICE_COUNTER_PROPERTY_KEY = "nextInvoiceNumber";

function nextInvoiceNumber(alreadyLocked) {
  var lock = alreadyLocked ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var current = parseInt(props.getProperty(INVOICE_COUNTER_PROPERTY_KEY), 10);
    if (!current) current = 1001;
    props.setProperty(INVOICE_COUNTER_PROPERTY_KEY, String(current + 1));
    return current;
  } finally {
    if (lock) lock.releaseLock();
  }
}

// Splits the "2× Medium room: £90, 1× Car interior (all seats): £55" string
// already built and stored at booking time back into invoice line items.
// Each item's own price was already computed once, correctly, by the price
// calculator at booking — this re-displays it, it never recalculates it.
function parseItemLines(itemsString) {
  return String(itemsString).split(", ").map(function (line) {
    var parts = line.split(": ");
    return { description: parts[0] || line, amount: parts[1] || "" };
  });
}

// Sends the invoice (and the signed completion PDF, when there is one).
// Consumers get the thank-you + review request. Agents get a plain invoice
// email to whoever booked, copied to the agency's accounts email if one is
// on the Agencies tab; no review request, since it's going to an office.
function sendThankYouEmail(v, inv, attachments) {
  var greetingName = inv.isAgent ? (v.Name || v["Business name"]) : v.Name;
  var dueStr = inv.paymentDue ? Utilities.formatDate(inv.dueDate, TIMEZONE, "d MMMM yyyy") : "";
  var subject, textBody;

  if (inv.isAgent) {
    subject = "Invoice " + inv.invoiceNo + " from EasyClean Somerset, " + v.Address;
    textBody = "Hi " + greetingName + ",\n\n" +
      "The clean at " + v.Address + " is done (our ref " + v.Reference + "). " +
      (inv.paymentDue
        ? "Invoice " + inv.invoiceNo + " for " + v.Total + " is attached, payment due by " + dueStr + ". Please use " + inv.invoiceNo + " as the payment reference."
        : "Invoice " + inv.invoiceNo + " is attached, paid in cash on the day.") +
      (attachments.length > 1 ? " The signed job completion confirmation is attached too." : "") +
      "\n\n" + aftercareText_(aftercareFor_(v.Items, true)) +
      "\n\nThanks,\nEasyClean Somerset";
  } else {
    subject = "Thanks for booking with EasyClean Somerset (Invoice " + inv.invoiceNo + ")";
    textBody = "Hi " + greetingName + ",\n\n" +
      "All done, thanks for booking with EasyClean Somerset. Your invoice/receipt is attached.\n\n" +
      (inv.paymentDue ? "Payment of " + v.Total + " is due today by bank transfer. The bank details are on the invoice; please use " + inv.invoiceNo + " as the payment reference.\n\n" : "") +
      aftercareText_(aftercareFor_(v.Items, false)) + "\n\n" +
      (REVIEW_URL ? "If you've got a minute, a review really helps a small business like ours: " + REVIEW_URL + "\n\n" : "") +
      "Thanks again,\nEasyClean Somerset";
  }

  var opts = {
    htmlBody: buildThankYouEmailHtml({
      name: greetingName, reference: v.Reference, invoiceNo: inv.invoiceNo,
      isAgent: inv.isAgent, paymentDue: inv.paymentDue, dueStr: dueStr,
      total: v.Total, address: v.Address, hasCompletion: attachments.length > 1,
      aftercare: aftercareFor_(v.Items, inv.isAgent)
    }),
    attachments: attachments,
    name: "EasyClean Somerset"
  };
  if (inv.accountsEmail && inv.accountsEmail.toLowerCase() !== String(v.Email).toLowerCase()) {
    opts.cc = inv.accountsEmail;
  }
  sendCustomerEmail_(v.Email, subject, textBody, opts);
}

// A standalone, emailed record of the sign-off itself — reference, what
// was done, and the actual signature graphic — independent of the Drive
// copy saveSignature() keeps, in case that one's ever moved, deleted, or
// (as happened 21 Sept 2026, before a Drive authorisation gap was found
// and fixed) silently never saved in the first place. Same rendering
// approach as the invoice: HtmlService -> PDF, plain CSS, self-contained.
function buildJobCompletionPdfBlob(v, invoiceNumber, completedAt, signatureDataUrl, photos, jobDate) {
  var esc = escHtml;
  var lines = parseItemLines(v.Items);
  var billToName = v.Channel === "Agent/Landlord" ? v["Business name"] : v.Name;
  var dateStr = Utilities.formatDate(completedAt, TIMEZONE, "d MMMM yyyy");
  var jobDateStr = jobDate ? Utilities.formatDate(jobDate, TIMEZONE, "d MMMM yyyy") : dateStr;
  var LOGO_URL = SITE_URL + "/apple-touch-icon.png";

  var itemsList = lines.map(function (l) {
    return '<li>' + esc(l.description) + '</li>';
  }).join("");

  var html =
    '<html><head><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#12232B;font-size:12px;margin:0;padding:32px;}' +
    'h1{font-size:20px;margin:0 0 2px;}' +
    '.muted{color:#5C6F73;}' +
    '.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;}' +
    '.brand img{display:block;width:32px;height:32px;}' +
    '.statement{margin:20px 0;padding:14px 16px;background:#F5F7F6;border-left:3px solid #0E7C86;font-size:12.5px;line-height:1.6;}' +
    'ul{margin:6px 0 0;padding-left:18px;}' +
    'li{padding:2px 0;}' +
    '.sig-block{margin-top:28px;}' +
    '.sig-label{font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#5C6F73;margin-bottom:6px;}' +
    '.sig-img{display:block;max-width:280px;max-height:110px;border-bottom:1px solid #12232B;padding-bottom:6px;}' +
    '.photos{margin-top:28px;}' +
    '.ph{width:45%;margin:0 2% 8px 0;border:1px solid #DCE3E2;}' +
    '.foot{margin-top:32px;font-size:11px;color:#5C6F73;}' +
    '</style></head><body>' +
    '<div class="brand"><img src="' + LOGO_URL + '" width="32" height="32" alt="" /><h1>Job Completion Confirmation</h1></div>' +
    '<div class="muted">Reference ' + esc(v.Reference) + '</div>' +
    '<div class="muted">Completed ' + esc(jobDateStr) + '</div>' +
    (jobDateStr !== dateStr ? '<div class="muted">Signed ' + esc(dateStr) + '</div>' : '') +
    '<div class="muted" style="margin-top:14px;">' + esc(billToName) + '</div>' +
    '<div class="muted">' + esc(v.Address) + '</div>' +
    '<div class="muted" style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;margin-top:18px;">Work completed</div>' +
    '<ul>' + itemsList + '</ul>' +
    '<div class="statement">By signing below, the customer confirmed the work described above had been completed to their satisfaction.</div>' +
    '<div class="sig-block">' +
      '<div class="sig-label">' + (v.Channel === "Agent/Landlord" && v["Site contact name"]
        ? 'Signed by ' + esc(v["Site contact name"]) + ' (site contact)'
        : 'Customer signature') + '</div>' +
      '<img class="sig-img" src="' + signatureDataUrl + '" />' +
    '</div>' +
    photosPdfHtml_(photos) +
    '<div class="foot">EasyClean Somerset &middot; Invoice ' + esc(formatInvoiceNo(invoiceNumber)) + '</div>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).getAs("application/pdf").setName("Job-completion-" + v.Reference + ".pdf");
}

// ---- Aftercare and the 2-day follow-up (FRE-193) ----
// Terms section 8 says we give the drying time before leaving; the email
// repeats the general advice so it's in writing. Change the wording here.
var AFTERCARE_DRYING = "Carpets and upholstery are usually dry in 4 to 6 hours. It can take longer on cold or damp days, or for thick wool, and we'll have given you a time before we left.";

// The aftercare advice for one job, from its items text.
function aftercareFor_(items, isAgent) {
  var text = String(items || "");
  var tips;
  if (isAgent) {
    tips = [
      "Ventilation helps it dry: a window open and the heating on if it's cold.",
      "Furniture shouldn't go back until it's fully dry."
    ];
  } else {
    tips = [
      "Keep air moving: open a window or two, and put the heating on if it's cold.",
      "Try to keep off it while it's damp. If you need to walk on it, wear clean socks or slippers, not outdoor shoes.",
      "Wait until it's fully dry before putting furniture back. If something has to go back sooner, put foil or a plastic lid under each leg.",
      "Keep pets and children off it until it's dry."
    ];
    if (/mattress/i.test(text)) tips.push("Let the mattress dry fully, with the room aired, before putting the bedding back on.");
    if (/car interior/i.test(text)) tips.push("Leave the car windows open a little, if it's safe to, so the seats dry.");
    tips.push("Once it's dry, a quick vacuum lifts the pile.");
  }
  return {
    drying: AFTERCARE_DRYING,
    tips: tips,
    guarantee: isAgent
      ? "If you or the check-out inspection find anything not right with what we cleaned, tell us within 7 days by email or WhatsApp and we'll come back and re-clean it free of charge."
      : "If a mark comes back as it dries, or anything else isn't right, tell us within 7 days by email or WhatsApp and we'll come back and re-clean that area free of charge."
  };
}

function aftercareText_(a) {
  return "Aftercare\n" + a.drying + "\n" + a.tips.map(function (t) { return "- " + t; }).join("\n") + "\n\n" + a.guarantee;
}

function aftercareHtml_(a, c) {
  var esc = escHtml;
  return '<div style="margin:0 0 22px;padding:16px 18px;background:' + c.PAPER + ';border:1px solid ' + c.LINE + ';">' +
    '<div style="font-family:' + c.SANS + ';font-weight:800;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:' + c.INK + ';margin:0 0 8px;">Aftercare</div>' +
    '<p style="margin:0 0 8px;font-family:' + c.SANS + ';font-size:14px;line-height:1.6;color:' + c.SLATE + ';">' + esc(a.drying) + '</p>' +
    '<ul style="margin:0 0 10px;padding-left:18px;font-family:' + c.SANS + ';font-size:14px;line-height:1.6;color:' + c.SLATE + ';">' +
      a.tips.map(function (t) { return '<li style="margin:0 0 4px;">' + esc(t) + '</li>'; }).join("") +
    '</ul>' +
    '<p style="margin:0;font-family:' + c.SANS + ';font-size:14px;line-height:1.6;color:' + c.INK + ';">' + esc(a.guarantee) + '</p>' +
  '</div>';
}

// A short check-in 2 days after a job is signed off, while the 7-day
// guarantee window is still open, so a problem gets raised with us rather
// than in a review. Runs from the daily trigger. Picks up jobs signed off 2
// to 4 days ago (so a missed morning doesn't lose one), with an email
// address and no follow-up sent yet. Asks every customer for a review the
// same way (the fake-reviews rules don't allow only asking happy ones).
function sendFollowUps_() {
  var sheet = getCustomerSheet();
  if (!sheet) return 0;
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var now = new Date();
  var sent = 0, col = -1;
  for (var i = 1; i < data.length; i++) {
    var v = rowToObject(header, data[i]);
    if (!v.Reference || !v.Email || v["Cancelled at"] || v["Follow-up sent"]) continue;
    if (!(v["Completed at"] instanceof Date)) continue;
    var daysAgo = calendarDaysBetween_(v["Completed at"], now);
    if (daysAgo < 2 || daysAgo > 4) continue;
    try {
      sendFollowUpEmail_(v);
      if (col === -1) { header = ensureColumns(sheet, ["Follow-up sent"]); col = header.indexOf("Follow-up sent") + 1; }
      sheet.getRange(i + 1, col).setValue(new Date());
      sent++;
    } catch (err) {
      noteProblem_("2-day follow-up failed for " + v.Reference, err);
    }
  }
  return sent;
}

function sendFollowUpEmail_(v) {
  var isAgent = v.Channel === "Agent/Landlord";
  var name = isAgent ? (v.Name || v["Business name"]) : v.Name;
  var completed = v["Completed at"];
  var cleanedOn = Utilities.formatDate(jobDateFor_(v, completed, true), TIMEZONE, "EEEE d MMMM");
  var deadline = Utilities.formatDate(new Date(completed.getTime() + 7 * 86400000), TIMEZONE, "EEEE d MMMM");
  var waLink = "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent("Hi EasyClean Somerset, about the clean on " + cleanedOn + ". Ref: " + v.Reference);
  // Each paragraph: text, plus an optional link (shown as words in the HTML
  // version, as the address in the plain-text version).
  var paras = isAgent
    ? [{ text: "Just checking in on the clean at " + v.Address + " on " + cleanedOn + " (our ref " + v.Reference + ")." },
       { text: "If the check-out or inspection flags anything about what we cleaned, tell us by " + deadline + " and we'll come back and re-clean it free of charge. Reply to this email or", link: { label: "message us on WhatsApp", url: waLink } }]
    : [{ text: "Just checking in after we cleaned for you on " + cleanedOn + ". How is everything looking now it's dry?" },
       { text: "If anything isn't right, such as a mark that's come back or an area that still feels damp, tell us by " + deadline + " and we'll come back and re-clean it free of charge. Reply to this email or", link: { label: "message us on WhatsApp", url: waLink } }];
  if (!isAgent && REVIEW_URL) paras.push({ text: "If you have a minute, we'd welcome a review of how it went." });
  var textBody = "Hi " + name + ",\n\n" +
    paras.map(function (p) { return p.text + (p.link ? " " + p.link.label + ": " + p.link.url : ""); }).join("\n\n") +
    (!isAgent && REVIEW_URL ? "\n" + REVIEW_URL : "") +
    "\n\nThanks,\nEasyClean Somerset";
  sendCustomerEmail_(v.Email, isAgent ? "Checking in: the clean at " + v.Address : "How's everything looking after your clean?", textBody, {
    htmlBody: buildSimpleEmailHtml({
      name: name, heading: isAgent ? "Checking in on the clean" : "How's it looking?", paragraphs: paras,
      button: !isAgent && REVIEW_URL ? { text: "Leave us a review", url: REVIEW_URL } : null
    }),
    name: "EasyClean Somerset"
  });
}

function buildThankYouEmailHtml(d) {
  var esc = escHtml;
  var INK = "#12232B", TEAL = "#0E7C86", PAPER = "#F5F7F6", SURFACE = "#FFFFFF";
  var LINE = "#DCE3E2", SLATE = "#5C6F73", ON_INK = "#F5F7F6", STAMP = "#B5461E";
  var SANS = "Arial,Helvetica,sans-serif";
  var LOGO_URL = SITE_URL + "/apple-touch-icon.png";

  return (
    '<div style="background:' + PAPER + ';padding:40px 16px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
        '<tr><td style="background:' + INK + ';padding:30px 28px 26px;text-align:center;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">' +
            '<tr>' +
              '<td style="width:40px;height:40px;vertical-align:middle;">' +
                '<img src="' + LOGO_URL + '" width="40" height="40" alt="EasyClean Somerset" style="display:block;width:40px;height:40px;" />' +
              '</td>' +
              '<td style="width:14px;font-size:14px;">&nbsp;</td>' +
              '<td style="text-align:left;vertical-align:middle;">' +
                '<span style="font-family:' + SANS + ';font-weight:800;font-size:19px;letter-spacing:0.01em;text-transform:uppercase;color:' + ON_INK + ';">Easy<span style="color:' + TEAL + ';">Clean</span> Somerset</span>' +
              '</td>' +
            '</tr>' +
          '</table>' +
        '</td></tr>' +
        '<tr><td style="background:' + SURFACE + ';border-left:1px solid ' + LINE + ';border-right:1px solid ' + LINE + ';padding:32px 28px 30px;">' +
          '<p style="margin:0 0 6px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Hi ' + esc(d.name) + ',</p>' +
          '<h1 style="margin:0 0 6px;font-family:' + SANS + ';font-weight:800;font-size:26px;letter-spacing:-0.01em;color:' + INK + ';">' + (d.isAgent ? 'Job complete, invoice attached' : 'All done, thanks for booking') + '</h1>' +
          '<div style="width:36px;height:3px;background:' + STAMP + ';margin:0 0 18px;font-size:3px;line-height:3px;">&nbsp;</div>' +
          (d.isAgent
            ? '<p style="margin:0 0 14px;font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + SLATE + ';">The clean at ' + esc(d.address) + ' is done (our reference ' + esc(d.reference) + '). Invoice ' + esc(d.invoiceNo) + ' is attached' + (d.hasCompletion ? ', along with the signed job completion confirmation' : '') + '.</p>' +
              (d.paymentDue
                ? '<p style="margin:0 0 20px;font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + INK + ';"><strong>' + esc(d.total) + ' due by ' + esc(d.dueStr) + '.</strong> Please use <strong>' + esc(d.invoiceNo) + '</strong> as the payment reference. Bank details are on the invoice.</p>'
                : '<p style="margin:0 0 20px;font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + SLATE + ';">Paid in cash on the day, nothing further to pay.</p>')
            : '<p style="margin:0 0 ' + (d.paymentDue ? '14' : '20') + 'px;font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + SLATE + ';">Your invoice (' + esc(d.invoiceNo) + ', reference ' + esc(d.reference) + ') is attached to this email.</p>' +
              (d.paymentDue
                ? '<p style="margin:0 0 20px;font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + INK + ';"><strong>' + esc(d.total) + ' is due today by bank transfer.</strong> The bank details are on the invoice; please use <strong>' + esc(d.invoiceNo) + '</strong> as the payment reference.</p>'
                : '')) +
          (d.aftercare ? aftercareHtml_(d.aftercare, { INK: INK, SLATE: SLATE, LINE: LINE, PAPER: PAPER, SANS: SANS }) : '') +
          (REVIEW_URL && !d.isAgent ?
            '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px;"><tr><td style="background:' + TEAL + ';border-radius:3px;">' +
              '<a href="' + REVIEW_URL + '" style="display:inline-block;padding:12px 24px;font-family:\'Public Sans\',' + SANS + ';font-weight:700;font-size:14.5px;color:' + ON_INK + ';text-decoration:none;">Leave us a review</a>' +
            '</td></tr></table>' +
            '<p style="margin:14px 0 0;font-family:' + SANS + ';font-size:13px;color:' + SLATE + ';">If you&#8217;ve got a minute, it really helps a small business like ours.</p>'
            : '') +
        '</td></tr>' +
        '<tr><td style="background:' + PAPER + ';border:1px solid ' + LINE + ';border-top:none;padding:22px 28px;text-align:center;">' +
          '<div style="font-family:' + SANS + ';font-weight:800;font-size:12.5px;letter-spacing:0.02em;text-transform:uppercase;color:' + SLATE + ';">EasyClean Somerset</div>' +
        '</td></tr>' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
      '</table>' +
      traderHtml_() +
    '</div>'
  );
}

// Rendered via HtmlService -> PDF rather than a Google Docs template, to
// keep this whole system self-contained in one file with no extra Drive
// document to lose track of. Plain CSS rather than the email builders'
// table/inline-style approach, since this only ever goes through Apps
// Script's own HTML-to-PDF conversion, not an email client.
function buildInvoicePdfBlob(v, inv) {
  var esc = escHtml;
  var lines = parseItemLines(v.Items);
  var dateStr = Utilities.formatDate(inv.completedAt, TIMEZONE, "d MMMM yyyy");
  // The clean's own date, shown when it's earlier than the invoice date (a
  // job signed off later). Cash is paid on the day of the clean.
  var jobDateStr = inv.jobDate ? Utilities.formatDate(inv.jobDate, TIMEZONE, "d MMMM yyyy") : dateStr;
  // Same brand-kit icon the site favicon and email headers use, so the
  // invoice carries the current logo automatically whenever that file
  // is updated — nothing here to touch when the mark changes again.
  var LOGO_URL = SITE_URL + "/apple-touch-icon.png";
  var CONTACT_EMAIL = "easycleansomerset@gmail.com";

  var rows = lines.map(function (l) {
    return '<tr><td class="desc">' + esc(l.description) + '</td><td class="amt">' + esc(l.amount) + '</td></tr>';
  }).join("");

  var label = function (t) { return '<div class="label">' + t + '</div>'; };
  var statusPill = inv.paymentDue
    ? '<span class="pill due">Payment due</span>'
    : '<span class="pill paid">Paid</span>';

  // Meta block under the invoice number: dates, and for agents their own
  // reference so their accounts team can match it.
  var meta = '<div class="muted">' + esc(inv.invoiceNo) + '</div>' +
    '<div class="muted">Invoice date ' + esc(dateStr) + '</div>' +
    (jobDateStr !== dateStr ? '<div class="muted">Job date ' + esc(jobDateStr) + '</div>' : '') +
    (inv.paymentDue ? '<div class="muted">Due ' + esc(Utilities.formatDate(inv.dueDate, TIMEZONE, "d MMMM yyyy")) + '</div>' : '') +
    '<div class="muted">Job ref ' + esc(v.Reference) + '</div>' +
    (inv.isAgent && v["Agent/Agency ID"] ? '<div class="muted">Your ref ' + esc(v["Agent/Agency ID"]) + '</div>' : '');

  var billTo = label("Billed to") +
    '<div class="strong">' + esc(inv.billToName) + '</div>' +
    (inv.billToAddress ? '<div class="muted pre">' + esc(inv.billToAddress) + '</div>' : '');

  // Agents: the property is a separate line from who's paying.
  var workAt = inv.isAgent
    ? '<td class="half">' + label(inv.workAtLabel || "Work carried out at") +
        '<div>' + esc(v.Address) + '</div>' +
        (v["Site contact name"] ? '<div class="muted">Site contact: ' + esc(v["Site contact name"]) + '</div>' : '') +
      '</td>'
    : '<td class="half"></td>';

  var payment;
  if (inv.paymentDue) {
    var b = inv.bank;
    payment = '<div class="paybox">' + label("How to pay") +
      (inv.dueOnCompletion
        ? '<div class="strong">Please pay ' + esc(v.Total) + ' by bank transfer today.</div>'
        : '<div class="strong">Please pay ' + esc(v.Total) + ' by bank transfer within ' + AGENT_PAYMENT_TERMS_DAYS + ' days, by ' +
          esc(Utilities.formatDate(inv.dueDate, TIMEZONE, "d MMMM yyyy")) + '.</div>') +
      (b.complete
        ? '<table class="bank">' +
            '<tr><td>Account name</td><td>' + esc(b.accountName) + '</td></tr>' +
            '<tr><td>Sort code</td><td>' + esc(b.sortCode) + '</td></tr>' +
            '<tr><td>Account number</td><td>' + esc(b.accountNumber) + '</td></tr>' +
            '<tr><td>Payment reference</td><td><strong>' + esc(inv.invoiceNo) + '</strong></td></tr>' +
          '</table>'
        : '<div style="margin-top:6px;">Please email ' + CONTACT_EMAIL + ' for bank details, quoting ' + esc(inv.invoiceNo) + ' as the payment reference.</div>') +
      '</div>';
  } else {
    payment = v["Payment method"] === "No charge"
      ? '<div class="foot">No charge. Thanks for using EasyClean Somerset.</div>'
      : '<div class="foot">Paid by ' + esc(v["Payment method"]) + ' on ' + esc(jobDateStr) + '. Thanks for booking with EasyClean Somerset.</div>';
  }

  var html =
    '<html><head><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#12232B;font-size:12px;margin:0;padding:32px;}' +
    'h1{font-size:20px;margin:0 0 2px;}' +
    '.muted{color:#5C6F73;}' +
    '.strong{font-weight:bold;}' +
    '.pre{white-space:pre-line;}' +
    '.label{font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#5C6F73;margin-bottom:4px;}' +
    '.layout{width:100%;border-collapse:collapse;margin:0 0 20px;}' +
    '.layout td{border:none;padding:0;vertical-align:top;}' +
    '.half{width:50%;}' +
    '.brand img{width:32px;height:32px;vertical-align:middle;margin-right:8px;}' +
    '.brand h1{display:inline;vertical-align:middle;}' +
    '.pill{display:inline-block;margin-top:8px;padding:3px 10px;border-radius:10px;font-size:10px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;}' +
    '.pill.paid{background:#E3F2F1;color:#0E7C86;}' +
    '.pill.due{background:#F9E6DF;color:#B5461E;}' +
    'table.items{width:100%;border-collapse:collapse;margin-top:8px;}' +
    'table.items th{text-align:left;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#5C6F73;border-bottom:1px solid #DCE3E2;padding:6px 0;}' +
    'table.items td{padding:8px 0;border-bottom:1px solid #DCE3E2;}' +
    'table.items .amt{text-align:right;}' +
    '.total-row td{border-bottom:none !important;border-top:2px solid #12232B;font-weight:bold;padding-top:12px !important;}' +
    '.paybox{margin-top:26px;padding:14px 16px;background:#F5F7F6;border-left:3px solid #B5461E;line-height:1.5;}' +
    'table.bank{border-collapse:collapse;margin-top:8px;}' +
    'table.bank td{padding:2px 18px 2px 0;border:none;}' +
    'table.bank td:first-child{color:#5C6F73;}' +
    '.foot{margin-top:32px;font-size:11px;color:#5C6F73;}' +
    '</style></head><body>' +
    '<table class="layout"><tr>' +
      '<td class="half">' +
        '<div class="brand"><img src="' + LOGO_URL + '" width="32" height="32" alt="" /><h1>Invoice</h1></div>' +
        meta + statusPill +
      '</td>' +
      '<td class="half" style="text-align:right;">' +
        '<div class="strong">' + esc(BUSINESS_NAME) + '</div>' +
        '<div class="muted">trading as EasyClean Somerset</div>' +
        '<div class="muted">' + esc(BUSINESS_ADDRESS) + '</div>' +
        '<div class="muted">' + CONTACT_EMAIL + '</div>' +
      '</td>' +
    '</tr></table>' +
    '<table class="layout"><tr><td class="half">' + billTo + '</td>' + workAt + '</tr></table>' +
    '<table class="items"><tr><th>Description</th><th class="amt">Amount</th></tr>' +
      rows +
      '<tr class="total-row"><td>Total' + (inv.paymentDue ? ' due' : '') + '</td><td class="amt">' + esc(v.Total) + '</td></tr>' +
    '</table>' +
    payment +
    (inv.isAgent && inv.paymentDue ? '<div class="foot">' + esc(latePaymentText_(v.Total)) + '</div>' : '') +
    (inv.paymentDue ? '<div class="foot">Thanks for using EasyClean Somerset.</div>' : '') +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).getAs("application/pdf").setName(inv.invoiceNo + " " + v.Reference + ".pdf");
}

// ============================================================
// Booking references, secret job tokens, and the private admin app
// ============================================================
//
// Why this exists: the short "EC-12345" reference is fine for people to
// read and quote, but it's short enough to guess. So nothing public ever
// accepts it. Every booking also gets a long random "Job token" (stored in
// the sheet), which is what the customer signing link carries. Everything
// Niall does himself (on-site sign-off, sending signing links, marking
// invoices paid) lives in the private admin app below, which only opens for
// the Google account that owns this script.
//
// ADMIN APP SETUP (one-time):
//   1. In the Apps Script editor: + (Add a file) -> HTML -> name it
//      "Dashboard" and paste in Dashboard.html. (Deliberately a different
//      word from the website's admin.html launcher page, so the two can't be
//      mixed up.)
//   2. Deploy -> New deployment -> Web app -> Execute as: Me ->
//      Who has access: Only myself -> Deploy. Copy that /exec URL.
//      (This is a SECOND deployment. Leave the existing public one alone.)
//   3. Project Settings -> Script Properties -> add ADMIN_URL = that URL.
//   4. Nothing to run: the admin app gives any booking without a job
//      token one the first time it loads.
//   5. Open ADMIN_URL on your phone (in a browser where the business Google
//      account is the default, i.e. signed into first) and "Add to Home
//      Screen".
// After any later Code.gs or Dashboard.html change, redeploy BOTH deployments
// as a new version (Manage deployments -> edit each -> New version).

var ADMIN_URL_PROPERTY_KEY = "ADMIN_URL";
var JOB_LINK_LABEL = "Job link (tap on the day to sign it off): ";

// "EC-" + 5 digits, checked against every reference already in the sheet.
// (Older bookings have 4 digits; both formats keep working.)
function newBookingReference() {
  var existing = {};
  try {
    var sheet = getCustomerSheet();
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      var col = data[0].indexOf("Reference");
      for (var i = 1; i < data.length; i++) existing[data[i][col]] = true;
    }
  } catch (err) {
    noteProblem_("Couldn't read existing booking references", err);
  }
  for (var attempt = 0; attempt < 50; attempt++) {
    var ref = "EC-" + Math.floor(10000 + Math.random() * 90000);
    if (!existing[ref]) return ref;
  }
  return "EC-" + Math.floor(10000 + Math.random() * 90000) + Math.floor(Math.random() * 10);
}

// 32 hex characters from a random UUID: not guessable.
function newJobToken() {
  return Utilities.getUuid().replace(/-/g, "");
}

function isPlausibleToken(token) {
  return typeof token === "string" && /^[0-9a-f]{32}$/i.test(token);
}

function findBookingByToken(token) {
  return findBookingByTokenColumn_("Job token", token);
}

// The job token (signing off, admin app) and the manage token (the
// customer's change-or-cancel link) live in different columns, so one can
// never be used as the other.
function findBookingByTokenColumn_(column, token) {
  if (!isPlausibleToken(token)) return null;
  var sheet = getCustomerSheet();
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var col = data[0].indexOf(column);
  if (col === -1) return null;
  for (var i = 1; i < data.length; i++) {
    if (data[i][col] === token) return { rowIndex: i + 1, values: rowToObject(data[0], data[i]) };
  }
  return null;
}

function publicSigningLink(token) {
  return SITE_URL + "/job-complete.html?t=" + encodeURIComponent(token);
}

function getAdminUrl() {
  return PropertiesService.getScriptProperties().getProperty(ADMIN_URL_PROPERTY_KEY) || "";
}

// Link written into each calendar event. Opens the job in the admin app
// (Google sign-in required), or says where to find it if the admin app
// isn't set up yet.
function adminJobLink(token, reference) {
  var url = getAdminUrl();
  return url ? url + "?page=job&t=" + encodeURIComponent(token)
             : "open the EasyClean admin app and search " + reference;
}

// True only when the person viewing is the Google account that owns this
// script. On the public deployment visitors are anonymous, so their email
// comes back blank and this is false. The "Only myself" deployment setting
// is the main wall; this is the second one.
function isOwner() {
  try {
    var active = Session.getActiveUser().getEmail();
    var owner = Session.getEffectiveUser().getEmail();
    return !!active && !!owner && active.toLowerCase() === owner.toLowerCase();
  } catch (err) {
    return false;
  }
}

function requireOwner() {
  if (!isOwner()) throw new Error("not_authorised");
}

function serveAdminPage(p) {
  if (!isOwner()) return notAvailable(); // plain text, never HTML (see doGet)
  // If the Admin HTML file is missing, empty or only half-pasted, say so
  // instead of showing a blank page.
  var problem = function (msg) {
    return HtmlService.createHtmlOutput("<p style=\"font-family:Arial,sans-serif;padding:24px;line-height:1.5;\">" + msg + "</p>")
      .setTitle("EasyClean admin");
  };
  var template;
  try {
    template = HtmlService.createTemplateFromFile("Dashboard");
  } catch (err) {
    return problem("Couldn't find the Dashboard file. In the Apps Script editor, add an HTML file named exactly <b>Dashboard</b>, paste in Dashboard.html, save, and redeploy as a new version.");
  }
  template.initJson = JSON.stringify({
    view: p.page === "job" ? "job" : "home",
    token: isPlausibleToken(p.t) ? p.t : ""
  }).replace(/</g, "\\u003c");
  var out = template.evaluate();
  if (out.getContent().indexOf('id="app"') === -1) {
    return problem("The Dashboard file in Apps Script looks empty or isn't the right file. Open it, select all, paste in the whole of Dashboard.html again, save, and redeploy as a new version.");
  }
  return out
    .setTitle("EasyClean admin")
    .setFaviconUrl(SITE_URL + "/favicon-32.png")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

// Gives every booking row without a job token one. Safe to run repeatedly.
function ensureJobTokens(sheet) {
  var header = ensureColumns(sheet, ["Job token"]);
  var col = header.indexOf("Job token");
  var data = sheet.getDataRange().getValues();
  var added = 0;
  for (var i = 1; i < data.length; i++) {
    if (!data[i][header.indexOf("Reference")]) continue; // blank row
    if (!data[i][col]) {
      var cell = sheet.getRange(i + 1, col + 1);
      cell.setNumberFormat("@"); // plain text, so Sheets never turns it into a number
      cell.setValue(newJobToken());
      added++;
    }
  }
  return added;
}

// ---- Admin app API (called from Dashboard.html via google.script.run) ----
// Every function checks the owner first. Dates go back as strings, since
// google.script.run can't return Date objects.

function fmtDay(d) {
  return d instanceof Date ? Utilities.formatDate(d, TIMEZONE, "EEE d MMM yyyy") : String(d || "");
}

function dayKey(d) {
  return Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd");
}

// Whole calendar days from a to b, in the business's time zone.
function calendarDaysBetween_(a, b) {
  var toUtc = function (d) { var p = dayKey(d).split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

function adminJobSummary(v, start) {
  var isAgent = v.Channel === "Agent/Landlord";
  var signerPhone = phoneText(isAgent ? (v["Site contact phone"] || v.Phone) : v.Phone);
  var due = v["Payment due"] instanceof Date ? v["Payment due"] : null;
  var today = new Date();
  var summary = {
    token: v["Job token"],
    reference: v.Reference,
    channel: v.Channel || "Consumer",
    name: isAgent ? v["Business name"] : v.Name,
    contact: isAgent ? (v["Site contact name"] || "") : "",
    access: isAgent ? (v.Access || (v["Site contact name"] ? "Someone on site" : "")) : "",
    notes: v.Notes || "",
    address: v.Address,
    items: v.Items,
    total: v["Cancellation fee"] || v.Total,
    bookingTotal: v.Total,
    payment: v["Payment method"],
    when: start ? fmtWhen(start) : bookingTimeText(v),
    cancelled: !!v["Cancelled at"],
    cancelledAt: fmtDay(v["Cancelled at"]),
    cancelledBy: v["Cancelled by"] || "",
    cancelNote: v["Cancellation note"] || "",
    cancelFee: v["Cancellation fee"] || "",
    remindedOn: fmtDay(v["Payment reminder sent"]),
    completed: !!v["Completed at"],
    completedAt: fmtDay(v["Completed at"]),
    invoiceNo: v["Invoice number"] ? formatInvoiceNo(v["Invoice number"]) : "",
    invoiceUrl: /^https?:/.test(String(v["Invoice PDF"] || "")) ? v["Invoice PDF"] : "",
    paymentDue: due ? fmtDay(due) : "",
    daysOverdue: due ? Math.floor((today - due) / 86400000) : 0,
    paidOn: fmtDay(v["Paid on"]),
    hasEmail: !!v.Email,
    whatsappNumber: toWhatsAppNumber(signerPhone),
    signingLink: v["Job token"] ? publicSigningLink(v["Job token"]) : ""
  };
  return plainForPage(summary);
}

function fmtWhen(d) {
  return Utilities.formatDate(d, TIMEZONE, "EEE d MMM, h:mma").replace("AM", "am").replace("PM", "pm");
}

// google.script.run silently turns the WHOLE response into null if any value
// in it is a Date (the page then fails with "null is not an object"). Google
// Sheets often stores things like the "Booking time" label as a real date,
// so every value going back to the admin page is converted here: dates to
// readable text, anything else non-basic to a string.
function plainForPage(obj) {
  var out = {};
  Object.keys(obj).forEach(function (k) {
    var val = obj[k];
    if (val instanceof Date) out[k] = isNaN(val.getTime()) ? "" : fmtWhen(val);
    else if (val === null || val === undefined) out[k] = "";
    else if (typeof val === "object") out[k] = String(val);
    else out[k] = val;
  });
  return out;
}

function adminGetOverview() {
  requireOwner();
  var sheet = getCustomerSheet();
  if (!sheet) return { ok: false, error: "no_sheet" };
  ensureJobTokens(sheet);
  ensureColumns(sheet, COMPLETION_COLUMNS.concat([EARLY_START_COLUMN]));
  var data = sheet.getDataRange().getValues();
  var header = data[0];

  // Each booking's time is kept in the sheet ("Starts at"), so a job stays in
  // these lists however long ago it was, and even if its calendar event was
  // deleted by hand (it shows as "Not in calendar"). When both are there the
  // calendar wins, since that's where times get moved (FRE-203).
  var now = new Date();
  var earliest = now.getTime() - 60 * 86400000;
  var i, v;
  for (i = 1; i < data.length; i++) {
    v = rowToObject(header, data[i]);
    if (!v.Reference || v["Completed at"] || v["Cancelled at"]) continue;
    var saved = sheetStart_(v);
    if (saved && saved.getTime() - 86400000 < earliest) earliest = saved.getTime() - 86400000;
  }
  var events = bookingEventsByRef_(new Date(earliest), new Date(now.getTime() + 400 * 86400000));

  var todayKey = dayKey(now);
  var today = [], waiting = [], upcoming = [], unpaid = [], recentlyPaid = [];
  for (i = 1; i < data.length; i++) {
    v = rowToObject(header, data[i]);
    if (!v.Reference) continue;
    var open = !v["Completed at"] && !v["Cancelled at"];
    var ev = open ? events[v.Reference] || null : null;
    if (ev) syncBookingTimes_(sheet, i + 1, v, ev);
    var start = ev ? ev.getStartTime() : (open ? sheetStart_(v) : null);
    var job = adminJobSummary(v, start);
    if (open) {
      if (!ev) job.calendarMissing = true;
      if (!start) {
        // An older booking with no saved time and no event: needs a look.
        job._sort = 0;
        waiting.push(job);
      } else {
        var k = dayKey(start);
        job._sort = start.getTime();
        if (k === todayKey) today.push(job);
        else if (k < todayKey) waiting.push(job);
        else if (start.getTime() - now.getTime() <= 30 * 86400000) upcoming.push(job);
      }
    }
    if (v["Payment due"] && !v["Paid on"]) {
      job._sort = v["Payment due"] instanceof Date ? v["Payment due"].getTime() : 0;
      unpaid.push(job);
    } else if (v["Payment due"] && v["Paid on"] instanceof Date && (now - v["Paid on"]) < 30 * 86400000) {
      job._paidSort = v["Paid on"].getTime();
      recentlyPaid.push(job);
    }
  }
  var bySort = function (a, b) { return a._sort - b._sort; };
  today.sort(bySort); waiting.sort(bySort); upcoming.sort(bySort); unpaid.sort(bySort);
  recentlyPaid.sort(function (a, b) { return b._paidSort - a._paidSort; });
  var strip = function (list) { return list.map(function (j) { delete j._sort; delete j._paidSort; return j; }); };
  return {
    ok: true,
    today: strip(today), waiting: strip(waiting), upcoming: strip(upcoming),
    unpaid: strip(unpaid), recentlyPaid: strip(recentlyPaid.slice(0, 10))
  };
}

function adminGetJob(token) {
  requireOwner();
  var row = findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  var t = bookingTimes_(row);
  var start = t.start;
  var job = adminJobSummary(row.values, start);
  job.ok = true;
  job.hasCalendarEvent = !!t.ev;
  job.hasSavedTime = !!sheetStart_(row.values);
  job.lateNotice = !!start && isLateCancellation(start, new Date());
  job.feeAmount = "£" + LATE_CANCELLATION_FEE;
  addTimingAndPhotos_(job, row);
  return job;
}

// Search by EC- reference (or part of a name/business), for jobs that
// aren't in the lists above. Returns every match, so a duplicated old
// 4-digit reference shows both bookings rather than silently picking one.
function adminSearch(query) {
  requireOwner();
  var q = String(query || "").trim().toLowerCase();
  if (q.length < 3) return { ok: true, results: [] };
  var sheet = getCustomerSheet();
  ensureJobTokens(sheet);
  var data = sheet.getDataRange().getValues();
  var results = [];
  for (var i = data.length - 1; i >= 1 && results.length < 20; i--) {
    var v = rowToObject(data[0], data[i]);
    var hay = [v.Reference, v.Name, v["Business name"], v.Address].join(" ").toLowerCase();
    if (hay.indexOf(q) !== -1) results.push(adminJobSummary(v, sheetStart_(v)));
  }
  return { ok: true, results: results };
}

function adminCompleteJob(token, signatureDataUrl, reason) {
  requireOwner();
  if (signatureDataUrl) return completeJob({ token: token, signature: signatureDataUrl });
  return completeJob({ token: token, noSignature: true, reason: reason || "" });
}

function adminSendSigningLink(token) {
  requireOwner();
  var row = findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  return sendSigningLinkForRow(row);
}

// isoDate is "yyyy-mm-dd" from the page's date picker. Stored at midday so
// a timezone shift can never move it to the day before.
function adminMarkPaid(token, isoDate, sendReceipt) {
  requireOwner();
  var row = findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  var v = row.values;
  if (!v["Invoice number"]) return { ok: false, error: "not_invoiced" };
  if (v["Paid on"]) return { ok: true, alreadyPaid: true };
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  var paidOn = m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : new Date();
  var sheet = getCustomerSheet();
  var header = ensureColumns(sheet, ["Paid on"]);
  sheet.getRange(row.rowIndex, header.indexOf("Paid on") + 1).setValue(paidOn);
  var receiptSent = false;
  if (sendReceipt && v.Email) {
    try {
      sendPaymentReceipt(v, paidOn);
      receiptSent = true;
    } catch (err) {
      noteProblem_("Receipt email failed for " + v.Reference, err);
    }
  }
  return { ok: true, paidOn: fmtDay(paidOn), receiptSent: receiptSent };
}

// Undo for a mis-tap. Only for invoices that had a payment due (agent
// invoices); consumer/cash jobs are paid at completion by definition.
function adminMarkUnpaid(token) {
  requireOwner();
  var row = findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  if (!row.values["Payment due"]) return { ok: false, error: "not_payment_due" };
  var sheet = getCustomerSheet();
  var header = ensureColumns(sheet, ["Paid on"]);
  sheet.getRange(row.rowIndex, header.indexOf("Paid on") + 1).setValue("");
  return { ok: true };
}


// ---- Time on job and before/after photos (FRE-194) ----
// Start and Finish taps on the admin app's job page record how long a job
// really took, next to the estimate the customer was given, so the price
// list can be recalibrated after the first 10 to 15 jobs. Photos are saved to
// a private Drive folder per job (evidence if there's a dispute, and
// marketing material), and for agent jobs can go in the completion PDF.

var TIMING_COLUMNS = ["Est. mins", "Started at", "Finished at", "Actual mins"];
var PHOTO_COLUMNS = ["Photos folder", "Photos in PDF"];
var PHOTOS_FOLDER_NAME = "EasyClean Somerset — Job photos";
var PHOTO_KINDS = { before: "Before", after: "After" };
var MAX_PHOTO_DATA_CHARS = 6000000; // about 4.5 MB of photo; the page sends about 0.5 MB
var PHOTOS_IN_PDF_MAX = 4;          // of each of Before and After
var AUTO_FINISH_MAX_MINS = 480;     // a job left running at sign-off is finished then, if within 8 hours

// Runs fn holding the script lock. Returns { ok:false } if it's busy.
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: "Busy, try again in a moment." }; }
  try { return fn(); } finally { lock.releaseLock(); }
}

// "~1h 55m", "2h" or "45 min" as minutes, or null.
function parseMinsText_(text) {
  var m = /^~?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*(?:min|m))?$/i.exec(String(text || "").trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  var mins = (parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0);
  return mins > 0 ? mins : null;
}

// The estimate for a job in minutes: from the sheet, or for older bookings
// from the "Est. time:" line in its calendar event. Null if there isn't one.
function estMinsFor_(v) {
  var stored = parseInt(v["Est. mins"], 10);
  if (stored > 0) return stored;
  try {
    var ev = findBookingEvent_(v.Reference, sheetStart_(v));
    var m = ev && /^Est\. time:\s*(.*)$/m.exec(ev.getDescription() || "");
    return m ? parseMinsText_(m[1]) : null;
  } catch (err) {
    return null;
  }
}

function validDate_(x) {
  return x instanceof Date && !isNaN(x.getTime()) ? x : null;
}

function clockText_(d) {
  return Utilities.formatDate(d, TIMEZONE, "h:mma").replace("AM", "am").replace("PM", "pm");
}

// What the job page needs to show the timer. Plain numbers and text only.
function timingFor_(v, estMins) {
  var s = validDate_(v["Started at"]), f = validDate_(v["Finished at"]);
  var actual = parseInt(v["Actual mins"], 10) || 0;
  if (!actual && s && f) actual = Math.max(0, Math.round((f.getTime() - s.getTime()) / 60000));
  return {
    estMins: estMins || 0,
    startedMs: s ? s.getTime() : 0,
    startedAt: s ? clockText_(s) : "",
    finishedMs: f ? f.getTime() : 0,
    actualMins: actual
  };
}

// Tap "Start job". Starting again after finishing starts a fresh timer.
function adminStartJob(token) {
  requireOwner();
  return withScriptLock_(function () {
    var row = findBookingByToken(token);
    if (!row) return { ok: false, error: "Couldn't find that job." };
    var v = row.values;
    if (v["Cancelled at"]) return { ok: false, error: "This booking is cancelled." };
    if (v["Completed at"]) return { ok: false, error: "This job is already signed off." };
    var est = estMinsFor_(v);
    if (validDate_(v["Started at"]) && !validDate_(v["Finished at"])) return { ok: true, timing: timingFor_(v, est) }; // already running
    var sheet = getCustomerSheet();
    var header = ensureColumns(sheet, TIMING_COLUMNS);
    var now = new Date();
    var writes = { "Started at": now, "Finished at": "", "Actual mins": "" };
    if (est && !(parseInt(v["Est. mins"], 10) > 0)) writes["Est. mins"] = est;
    setRowValues_(sheet, row.rowIndex, header, writes);
    var after = {}; Object.keys(v).forEach(function (k) { after[k] = v[k]; });
    after["Started at"] = now; after["Finished at"] = ""; after["Actual mins"] = "";
    return { ok: true, timing: timingFor_(after, est) };
  });
}

// Tap "Finish job". Records the minutes since Start.
function adminFinishJob(token) {
  requireOwner();
  return withScriptLock_(function () {
    var row = findBookingByToken(token);
    if (!row) return { ok: false, error: "Couldn't find that job." };
    var v = row.values;
    if (v["Completed at"]) return { ok: false, error: "This job is already signed off." };
    var est = estMinsFor_(v);
    var started = validDate_(v["Started at"]);
    if (!started) return { ok: false, error: "Tap Start job first." };
    if (validDate_(v["Finished at"])) return { ok: true, timing: timingFor_(v, est) }; // already finished
    var sheet = getCustomerSheet();
    var header = ensureColumns(sheet, TIMING_COLUMNS);
    var now = new Date();
    var mins = Math.max(0, Math.round((now.getTime() - started.getTime()) / 60000));
    setRowValues_(sheet, row.rowIndex, header, { "Finished at": now, "Actual mins": mins });
    var after = {}; Object.keys(v).forEach(function (k) { after[k] = v[k]; });
    after["Finished at"] = now; after["Actual mins"] = mins;
    return { ok: true, timing: timingFor_(after, est) };
  });
}

// Undo for a mis-tap: clears the timer (the estimate stays).
function adminResetTimer(token) {
  requireOwner();
  return withScriptLock_(function () {
    var row = findBookingByToken(token);
    if (!row) return { ok: false, error: "Couldn't find that job." };
    var v = row.values;
    if (v["Completed at"]) return { ok: false, error: "This job is already signed off." };
    var sheet = getCustomerSheet();
    var header = ensureColumns(sheet, TIMING_COLUMNS);
    setRowValues_(sheet, row.rowIndex, header, { "Started at": "", "Finished at": "", "Actual mins": "" });
    return { ok: true, timing: timingFor_({}, estMinsFor_(v)) };
  });
}

// The job's photo folder in Drive, or null (created first when `create`).
// The folder's link is kept in the sheet. If someone deletes the folder, the
// next photo starts a new one.
function photoFolderFor_(v, create) {
  var id = (/[-\w]{20,}$/.exec(String(v["Photos folder"] || "")) || [])[0];
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* gone: fall through */ }
  }
  if (!create) return null;
  var who = v.Channel === "Agent/Landlord" ? (v["Business name"] || v.Name) : v.Name;
  var name = (String(v.Reference) + " " + String(who || "")).replace(/[\\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return getOrCreateFolder(PHOTOS_FOLDER_NAME).createFolder(name);
}

function photoCounts_(folder, reference) {
  var counts = { before: 0, after: 0 };
  var files = folder.getFiles();
  while (files.hasNext()) {
    var name = files.next().getName();
    if (name.indexOf(reference + "-before-") === 0) counts.before++;
    else if (name.indexOf(reference + "-after-") === 0) counts.after++;
  }
  return counts;
}

// Adds the timer, photo counts and folder link to a job for the job page.
function addTimingAndPhotos_(job, row) {
  var v = row.values;
  var est = estMinsFor_(v);
  if (est && !(parseInt(v["Est. mins"], 10) > 0)) {
    // Remember it, so older bookings only look it up in the calendar once.
    try {
      var sheet = getCustomerSheet();
      setRowValues_(sheet, row.rowIndex, ensureColumns(sheet, ["Est. mins"]), { "Est. mins": est });
    } catch (err) { /* only a convenience */ }
  }
  var t = timingFor_(v, est);
  job.estMins = t.estMins; job.startedMs = t.startedMs; job.startedAt = t.startedAt;
  job.finishedMs = t.finishedMs; job.actualMins = t.actualMins;
  job.photoBefore = 0; job.photoAfter = 0; job.photosFolderUrl = "";
  job.photosInPdf = String(v["Photos in PDF"] || "") !== "No";
  try {
    var folder = photoFolderFor_(v, false);
    if (folder) {
      var c = photoCounts_(folder, v.Reference);
      job.photoBefore = c.before; job.photoAfter = c.after; job.photosFolderUrl = folder.getUrl();
    }
  } catch (err) {
    noteProblem_("Reading the photo folder failed for " + v.Reference, err);
  }
}

// Saves one photo (a JPEG data URL, already shrunk by the page) as Before or
// After. The page sends them one at a time.
function adminAddPhoto(token, kind, dataUrl) {
  requireOwner();
  var label = PHOTO_KINDS[String(kind || "").toLowerCase()];
  if (!label) return { ok: false, error: "Pick Before or After." };
  dataUrl = String(dataUrl || "");
  if (dataUrl.indexOf("data:image/jpeg;base64,") !== 0) return { ok: false, error: "That doesn't look like a photo." };
  if (dataUrl.length > MAX_PHOTO_DATA_CHARS) return { ok: false, error: "That photo is too big." };
  return withScriptLock_(function () {
    var row = findBookingByToken(token);
    if (!row) return { ok: false, error: "Couldn't find that job." };
    var v = row.values, ref = v.Reference;
    var folder = photoFolderFor_(v, true);
    var counts = photoCounts_(folder, ref);
    var n = counts[label.toLowerCase()] + 1;
    var stamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMdd-HHmmss");
    var name = ref + "-" + label.toLowerCase() + "-" + stamp + "-" + n + ".jpg";
    var bytes = Utilities.base64Decode(dataUrl.slice("data:image/jpeg;base64,".length));
    folder.createFile(Utilities.newBlob(bytes, "image/jpeg", name));
    counts[label.toLowerCase()] = n;
    var url = folder.getUrl();
    if (String(v["Photos folder"] || "") !== url) {
      var sheet = getCustomerSheet();
      setRowValues_(sheet, row.rowIndex, ensureColumns(sheet, PHOTO_COLUMNS), { "Photos folder": url });
    }
    return { ok: true, photoBefore: counts.before, photoAfter: counts.after, photosFolderUrl: url };
  });
}

// The "include the photos in the completion PDF" tick on the job page.
// Blank means yes, "No" means leave them out.
function adminSetPhotosInPdf(token, include) {
  requireOwner();
  return withScriptLock_(function () {
    var row = findBookingByToken(token);
    if (!row) return { ok: false, error: "Couldn't find that job." };
    var sheet = getCustomerSheet();
    setRowValues_(sheet, row.rowIndex, ensureColumns(sheet, PHOTO_COLUMNS), { "Photos in PDF": include ? "" : "No" });
    return { ok: true, photosInPdf: !!include };
  });
}

// Photos for an agent's completion PDF: up to PHOTOS_IN_PDF_MAX Before and
// After, oldest first, as data URLs. Null if none, or not an agent job, or
// the tick on the job page was turned off.
function photosForPdf_(v) {
  if (v.Channel !== "Agent/Landlord" || String(v["Photos in PDF"] || "") === "No") return null;
  var folder = photoFolderFor_(v, false);
  if (!folder) return null;
  var found = [], files = folder.getFiles();
  while (files.hasNext()) { var f = files.next(); found.push({ name: f.getName(), file: f }); }
  found.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  var out = { before: [], after: [] };
  found.forEach(function (x) {
    var kind = x.name.indexOf(v.Reference + "-before-") === 0 ? "before" : x.name.indexOf(v.Reference + "-after-") === 0 ? "after" : "";
    if (!kind || out[kind].length >= PHOTOS_IN_PDF_MAX) return;
    out[kind].push("data:image/jpeg;base64," + Utilities.base64Encode(x.file.getBlob().getBytes()));
  });
  return out.before.length || out.after.length ? out : null;
}

function photosPdfHtml_(photos) {
  if (!photos) return "";
  var grid = function (title, list) {
    return list.length
      ? '<div class="sig-label" style="margin:14px 0 6px;">' + title + '</div><div>' +
          list.map(function (u) { return '<img class="ph" src="' + u + '" />'; }).join("") + '</div>'
      : "";
  };
  return '<div class="photos"><div class="sig-label">Photos taken on the day</div>' +
    grid("Before", photos.before) + grid("After", photos.after) + '</div>';
}

// ---- Admin app: add a booking yourself, and edit a job (FRE-183) ----
// For phone, WhatsApp and Quick Quote jobs, price matches, extra items
// agreed on the day, moving a job, and £0 guarantee re-cleans. Bookings
// made here are the same as website bookings (reference, calendar event,
// reminders, invoice on sign-off), but with no 24-hour, price-list or
// postcode rules: you're in charge.

var ADMIN_PAYMENT_OPTIONS = ["Cash", "Bank transfer", "Invoice, 14 days", "No charge"];

function money_(n) {
  var neg = n < 0, a = Math.abs(Math.round(n * 100) / 100);
  return (neg ? "-£" : "£") + (a % 1 ? a.toFixed(2) : String(a));
}

function parseMoney_(s) {
  var m = /^(-?)£?(\d+(?:\.\d{1,2})?)$/.exec(String(s || "").replace(/[\s,]/g, ""));
  return m ? (m[1] ? -1 : 1) * parseFloat(m[2]) : null;
}

// An item line's wording can't contain ", " or ": " (the items text is
// split on those) or "×".
function cleanItemText_(s) {
  return String(s || "").replace(/[\r\n\t]+/g, " ").replace(/×/g, "x").replace(/,\s*/g, " ").replace(/:\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, 80);
}

// Turns the admin form into booking data, checking everything.
// Returns { error } or { data, start, end }.
function buildAdminBooking_(f) {
  f = f || {};
  var str = function (v, max) { return String(v === undefined || v === null ? "" : v).trim().slice(0, max); };
  var channel = f.channel === "Agent/Landlord" ? "Agent/Landlord" : "Consumer";
  var d = {
    channel: channel,
    name: str(f.name, 100),
    phone: str(f.phone, 40),
    email: str(f.email, 254),
    address: str(f.address, 300),
    businessName: str(f.businessName, 120),
    agencyId: str(f.agencyId, 60),
    siteContactName: str(f.siteContactName, 100),
    siteContactPhone: str(f.siteContactPhone, 40),
    accessArrange: channel === "Agent/Landlord" && !!f.accessArrange,
    referralCode: str(f.referralCode, 40),
    notes: str(f.notes, 500).replace(/[\r\n]+/g, " "),
    payment: ADMIN_PAYMENT_OPTIONS.indexOf(f.payment) !== -1 ? f.payment : "",
    bookedVia: "Admin app",
    marketingOptIn: false
  };
  var postcode = str(f.postcode, 12).toUpperCase();
  if (postcode && d.address.toUpperCase().replace(/\s/g, "").indexOf(postcode.replace(/\s/g, "")) === -1) d.address += ", " + postcode;
  if (!d.name) return { error: "Add a name." };
  if (!d.address) return { error: "Add an address." };
  if (!d.phone && !d.email) return { error: "Add a phone number or an email address." };
  if (d.email && !EMAIL_PATTERN.test(d.email)) return { error: "That email address doesn't look right." };
  if (d.phone && d.phone.replace(/\D/g, "").length < 7) return { error: "That phone number doesn't look right." };
  if (!d.payment) return { error: "Choose how they'll pay." };
  if (channel === "Agent/Landlord") {
    if (!d.businessName) d.businessName = d.name; // private landlord
    if (!d.accessArrange && !d.siteContactName) { d.siteContactName = d.name; d.siteContactPhone = d.siteContactPhone || d.phone; }
  }
  var lines = Array.isArray(f.lines) ? f.lines : [];
  if (!lines.length) return { error: "Add at least one item." };
  if (lines.length > 40) return { error: "That's too many lines." };
  var total = 0, mins = 0, parts = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i] || {};
    var desc = cleanItemText_(l.desc);
    var qty = parseInt(l.qty, 10);
    var unit = Number(l.unit);
    var lm = parseInt(l.mins, 10) || 0;
    if (!desc) return { error: "Every line needs a description." };
    if (!(qty >= 1 && qty <= 50)) return { error: "Check the quantity on \"" + desc + "\"." };
    if (!isFinite(unit) || Math.abs(unit) > 10000) return { error: "Check the price on \"" + desc + "\"." };
    unit = Math.round(unit * 100) / 100;
    lm = Math.max(0, Math.min(lm, 600));
    total += qty * unit;
    mins += qty * lm;
    parts.push(qty + "× " + desc + ": " + money_(qty * unit));
  }
  total = Math.round(total * 100) / 100;
  if (total < 0) return { error: "The total can't be below £0." };
  d.items = parts.join(", ");
  d.total = money_(total);
  d.estTime = "~" + formatMinsServer(FIXED_OVERHEAD_MINS + mins);

  var day = parseIsoDate_(f.date), t = parseHhmm_(f.time);
  if (!day || !t) return { error: "Pick a date and start time." };
  var start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m);
  var length = parseInt(f.lengthMins, 10);
  if (!(length >= 30 && length <= 720)) return { error: "Pick how long the job takes." };
  var end = new Date(start.getTime() + length * 60000);
  return { data: d, start: start, end: end };
}

// The calendar event for a booking, or null if it's been deleted.
// hintStart (the time saved in the sheet) is checked first, which is quick
// and works for jobs of any age; then a wide window, in case the event was
// dragged to another day in the calendar.
function findBookingEvent_(reference, hintStart) {
  var cal = CalendarApp.getDefaultCalendar();
  var pick = function (events) {
    for (var i = 0; i < events.length; i++) {
      if (referenceFromEvent(events[i]) === reference) return events[i];
    }
    return null;
  };
  if (hintStart) {
    var near = pick(cal.getEvents(new Date(hintStart.getTime() - 86400000), new Date(hintStart.getTime() + 86400000)));
    if (near) return near;
  }
  var now = new Date();
  var from = now.getTime() - 120 * 86400000;
  if (hintStart && hintStart.getTime() - 86400000 < from) from = hintStart.getTime() - 86400000;
  return pick(cal.getEvents(new Date(from), new Date(now.getTime() + 400 * 86400000)));
}

// ---- Booking times kept in the sheet (FRE-203) ----
// The calendar is still where a booking's time is set and moved. Its start
// and end are copied into the sheet as well ("Starts at", "Ends at"), so a
// job never drops out of the admin app because its event is old or was
// deleted by hand, and so it can be put back in the calendar if it was.
var START_COLUMNS = ["Starts at", "Ends at"];

// A job done this many days ago and still not signed off is in the morning
// check, since it hasn't been invoiced.
var SIGNOFF_NUDGE_DAYS = 3;

function sheetStart_(v) { return validDate_(v["Starts at"]); }

// The day a job was actually done: when the timer was started, or the
// booking's time (calendar first, then the time saved in the sheet). Never
// later than `notAfter` (the sign-off), and that's the answer if nothing else
// is known. sheetOnly skips the calendar (for jobs long since signed off).
function jobDateFor_(v, notAfter, sheetOnly) {
  var d = validDate_(v["Started at"]);
  if (!d && !sheetOnly) {
    try {
      var ev = findBookingEvent_(v.Reference, sheetStart_(v));
      if (ev) d = ev.getStartTime();
    } catch (err) {
      console.error("Calendar lookup for the job date failed for " + v.Reference + ": " + err);
    }
  }
  if (!d) d = sheetStart_(v);
  if (!d || (notAfter && d.getTime() > notAfter.getTime())) return notAfter || null;
  return d;
}
function sheetEnd_(v) { return validDate_(v["Ends at"]); }

// Every booking event in a window, by reference (one calendar lookup).
function bookingEventsByRef_(from, to) {
  var out = {};
  CalendarApp.getDefaultCalendar().getEvents(from, to).forEach(function (ev) {
    var ref = referenceFromEvent(ev);
    if (ref && !out[ref]) out[ref] = ev;
  });
  return out;
}

// Copies the event's time into the sheet when they differ (a new booking
// from before this version, or one dragged to a new time in the calendar).
function syncBookingTimes_(sheet, rowIndex, v, ev) {
  var start = ev.getStartTime(), end = ev.getEndTime();
  var savedStart = sheetStart_(v), savedEnd = sheetEnd_(v);
  if (savedStart && savedEnd && savedStart.getTime() === start.getTime() && savedEnd.getTime() === end.getTime()) return;
  try {
    var header = ensureColumns(sheet, START_COLUMNS);
    setRowValues_(sheet, rowIndex, header, { "Starts at": start, "Ends at": end });
    v["Starts at"] = start;
    v["Ends at"] = end;
  } catch (err) {
    noteProblem_("Saving the booking time in the sheet failed for " + v.Reference, err);
  }
}

// One booking's event and times. Open bookings get their sheet times
// brought up to date from the calendar on the way.
function bookingTimes_(row) {
  var v = row.values;
  var saved = sheetStart_(v);
  var ev = null;
  try {
    ev = findBookingEvent_(v.Reference, saved);
  } catch (err) {
    noteProblem_("Calendar lookup failed for " + v.Reference, err);
  }
  if (ev && !v["Completed at"] && !v["Cancelled at"]) syncBookingTimes_(getCustomerSheet(), row.rowIndex, v, ev);
  return { ev: ev, start: ev ? ev.getStartTime() : saved, end: ev ? ev.getEndTime() : sheetEnd_(v) };
}

// The details a calendar event needs, read back from a booking's row.
function bookingDataFromRow_(v) {
  var plain = function (x) { return x === undefined || x === null ? "" : String(x); };
  var isAgent = v.Channel === "Agent/Landlord";
  var mins = parseInt(v["Est. mins"], 10);
  return {
    channel: isAgent ? "Agent/Landlord" : "Consumer",
    name: plain(v.Name),
    businessName: plain(v["Business name"]) || plain(v.Name),
    items: plain(v.Items),
    total: plain(v.Total),
    estTime: mins > 0 ? "~" + formatMinsServer(mins) : "",
    phone: phoneText(v.Phone),
    email: plain(v.Email),
    payment: plain(v["Payment method"]),
    address: plain(v.Address),
    accessArrange: /^Agent arranging/.test(plain(v.Access)),
    siteContactName: plain(v["Site contact name"]),
    siteContactPhone: phoneText(v["Site contact phone"]),
    agencyId: plain(v["Agent/Agency ID"]),
    referralCode: plain(v["Referral / offer code"]),
    notes: plain(v.Notes),
    bookedVia: plain(v["Booked via"]) || "Website"
  };
}

// Makes a booking's calendar event again, from its row.
function createEventForRow_(v, start, end) {
  var d = bookingDataFromRow_(v);
  return CalendarApp.getDefaultCalendar().createEvent(bookingEventTitle_(d), start, end, {
    description: bookingEventDescription_(d, v.Reference, adminJobLink(v["Job token"], v.Reference)),
    location: d.address
  });
}

// Admin app: puts a booking back in the calendar after its event was
// deleted by hand, at the time saved in the sheet. Its time is then blocked
// on the website again and its reminders go out as normal.
function adminRestoreEvent(token, force) {
  requireOwner();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: "Busy, try again in a moment." }; }
  try {
    var row = findBookingByToken(token);
    if (!row) return { ok: false, error: "not_found" };
    var v = row.values;
    if (v["Cancelled at"]) return { ok: false, error: "This booking is cancelled." };
    if (v["Completed at"]) return { ok: false, error: "This job is already signed off." };
    var start = sheetStart_(v);
    if (findBookingEvent_(v.Reference, start)) return { ok: true, already: true };
    if (!start) return { ok: false, error: "There's no saved time for this booking. Use Edit job to set the time: saving puts it back in the calendar." };
    var end = sheetEnd_(v) || new Date(start.getTime() + SLOT_MINS * 60000);
    var clashes = clashesFor_(start, end, null);
    if (clashes.length && !force) return { ok: false, needsConfirm: true, clashes: clashes };
    createEventForRow_(v, start, end);
    try { refreshSlotsCache(); } catch (err) { console.error("Cache refresh after putting a booking back failed: " + err); }
    return { ok: true, when: fmtWhen(start) };
  } finally {
    lock.releaseLock();
  }
}

// For the morning check: open bookings with no calendar event, and jobs
// done more than SIGNOFF_NUDGE_DAYS ago that still aren't signed off.
function openBookingIssues_(now) {
  var out = { missing: [], unsigned: [] };
  var sheet = getCustomerSheet();
  if (!sheet) return out;
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var rows = [];
  var earliest = now.getTime() - 60 * 86400000;
  for (var i = 1; i < data.length; i++) {
    var v = rowToObject(header, data[i]);
    if (!v.Reference || v["Completed at"] || v["Cancelled at"]) continue;
    rows.push(v);
    var saved = sheetStart_(v);
    if (saved && saved.getTime() - 86400000 < earliest) earliest = saved.getTime() - 86400000;
  }
  if (!rows.length) return out;
  var events = bookingEventsByRef_(new Date(earliest), new Date(now.getTime() + 400 * 86400000));
  rows.forEach(function (v) {
    var ev = events[v.Reference];
    var start = ev ? ev.getStartTime() : sheetStart_(v);
    var label = v.Reference + " (" + (start ? fmtWhen(start) : bookingTimeText(v) || "no time saved") + ")";
    if (!ev) out.missing.push(label);
    if (start && now.getTime() - start.getTime() > SIGNOFF_NUDGE_DAYS * 86400000) out.unsigned.push(label);
  });
  return out;
}

// ---- One-time booking IDs (FRE-203, FRE-6) ----
// The booking page sends a random requestId with each booking and reuses it
// if it has to send the booking again (a dropped connection). A requestId
// already booked gets the same answer back, never a second booking.
var REQUEST_ID_COLUMN = "Request ID";
var REQUEST_ID_CACHE_SECONDS = 21600; // 6 hours; the sheet column covers longer

function cleanRequestId_(x) {
  var id = typeof x === "string" ? x.trim() : "";
  return /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : "";
}

function rememberRequestId_(id, reference) {
  if (!id) return;
  try {
    CacheService.getScriptCache().put("bookingRequest_" + id, reference, REQUEST_ID_CACHE_SECONDS);
  } catch (err) {
    noteProblem_("Remembering a booking's request ID failed for " + reference, err);
  }
}

// The reference already booked for this requestId, or null.
function bookingForRequestId_(id) {
  try {
    var hit = CacheService.getScriptCache().get("bookingRequest_" + id);
    if (hit) return hit;
  } catch (err) {
    console.error("Request ID cache read failed: " + err);
  }
  var sheet = getCustomerSheet();
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var col = data[0].indexOf(REQUEST_ID_COLUMN), refCol = data[0].indexOf("Reference");
  if (col === -1 || refCol === -1) return null;
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][col]) === id) return data[i][refCol];
  }
  return null;
}

// Other things already in the calendar at that time (bookings, blocks,
// personal events), described for a "book it anyway?" check.
function clashesFor_(start, end, ignoreEvent) {
  var ignoreId = ignoreEvent ? ignoreEvent.getId() : null;
  return CalendarApp.getDefaultCalendar().getEvents(start, end)
    .filter(function (ev) { return !ignoreId || ev.getId() !== ignoreId; })
    .map(function (ev) { return referenceFromEvent(ev) || String(ev.getTitle() || "Something in your calendar"); });
}

// Writes named columns on one row, keeping text columns as plain text.
function setRowValues_(sheet, rowIndex, header, obj) {
  Object.keys(obj).forEach(function (h) {
    var col = header.indexOf(h) + 1;
    if (!col) return;
    var cell = sheet.getRange(rowIndex, col);
    var val = obj[h];
    if (TEXT_COLUMNS.indexOf(h) !== -1) {
      cell.setNumberFormat("@");
      if (typeof val === "string" && val.charAt(0) === "=") val = " " + val;
    }
    cell.setValue(val);
  });
}

// The admin item list for one channel, in price-list order.
function adminGetPriceList(channel) {
  requireOwner();
  try {
    var list = getPriceList(channel === "Agent/Landlord" ? "Agent/Landlord" : "Consumer");
    return {
      ok: true,
      items: Object.keys(list).map(function (k) { return { item: k, price: list[k].price, mins: list[k].mins }; }),
      overheadMins: FIXED_OVERHEAD_MINS, slotMins: SLOT_MINS
    };
  } catch (err) {
    return { ok: true, items: [], overheadMins: FIXED_OVERHEAD_MINS, slotMins: SLOT_MINS, warning: "Couldn't read the price list from the website, so add items as custom lines." };
  }
}

function adminCreateBooking(form) {
  requireOwner();
  var built = buildAdminBooking_(form);
  if (built.error) return { ok: false, error: built.error };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: "Busy, try again in a moment." }; }
  try {
    var clashes = clashesFor_(built.start, built.end, null);
    if (clashes.length && !form.force) return { ok: false, needsConfirm: true, clashes: clashes };
    var d = built.data;
    var reference = newBookingReference();
    var jobToken = newJobToken();
    d.manageToken = newJobToken(); // the customer's change-or-cancel link (FRE-213)
    d.startsAt = built.start;
    d.endsAt = built.end;
    var cal = CalendarApp.getDefaultCalendar();
    cal.createEvent(bookingEventTitle_(d), built.start, built.end, {
      description: bookingEventDescription_(d, reference, adminJobLink(jobToken, reference)),
      location: d.address
    });
    appendCustomerRow(d, reference, fmtWhen(built.start), jobToken);
    try { refreshSlotsCache(); } catch (err) { console.error("Cache refresh after admin booking failed: " + err); }
    var emailed = false, emailError = "";
    if (form.emailCustomer && d.email) {
      try { sendBookingConfirmation_(d, reference, fmtWhen(built.start)); emailed = true; }
      catch (err) { emailError = String(err); console.error("Admin booking confirmation failed: " + err); }
    }
    return { ok: true, reference: reference, token: jobToken, emailed: emailed, emailError: emailError };
  } finally {
    lock.releaseLock();
  }
}

// Everything the edit form needs, including the items split back into lines.
function adminGetJobForEdit(token) {
  requireOwner();
  var row = findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  var v = row.values;
  var ev = findBookingEvent_(v.Reference, sheetStart_(v));
  var start = ev ? ev.getStartTime() : sheetStart_(v), end = ev ? ev.getEndTime() : sheetEnd_(v);
  var list = {};
  try { list = getPriceList(v.Channel === "Agent/Landlord" ? "Agent/Landlord" : "Consumer"); } catch (err) { list = {}; }
  var lines = String(v.Items || "").split(", ").filter(function (x) { return x; }).map(function (part) {
    var cut = part.lastIndexOf(": ");
    var left = cut === -1 ? part : part.slice(0, cut);
    var amount = cut === -1 ? null : parseMoney_(part.slice(cut + 2));
    var m = /^(\d+)×\s*(.*)$/.exec(left);
    var qty = m ? parseInt(m[1], 10) : 1;
    var desc = m ? m[2] : left;
    var unit = amount === null ? 0 : Math.round(amount / qty * 100) / 100;
    if (amount !== null && Math.round(unit * qty * 100) !== Math.round(amount * 100)) {
      // Doesn't split evenly into a unit price, so keep it as one line with the exact amount.
      desc = qty + "x " + desc; qty = 1; unit = amount;
    }
    return { desc: desc, qty: qty, unit: unit, mins: list[desc] ? list[desc].mins : 0, fromList: !!list[desc] };
  });
  var plain = function (x) { return x instanceof Date ? fmtWhen(x) : String(x === undefined || x === null ? "" : x); };
  return {
    ok: true,
    token: token, reference: v.Reference,
    cancelled: !!v["Cancelled at"], completed: !!v["Completed at"],
    channel: v.Channel === "Agent/Landlord" ? "Agent/Landlord" : "Consumer",
    name: plain(v.Name), phone: phoneText(v.Phone), email: plain(v.Email), address: plain(v.Address),
    businessName: plain(v["Business name"]), agencyId: plain(v["Agent/Agency ID"]),
    siteContactName: plain(v["Site contact name"]), siteContactPhone: phoneText(v["Site contact phone"]),
    accessArrange: /^Agent arranging/.test(String(v.Access || "")),
    referralCode: plain(v["Referral / offer code"]), notes: plain(v.Notes),
    payment: plain(v["Payment method"]),
    lines: lines,
    date: start ? Utilities.formatDate(start, TIMEZONE, "yyyy-MM-dd") : "",
    time: start ? Utilities.formatDate(start, TIMEZONE, "HH:mm") : "",
    lengthMins: start && end ? Math.round((end - start) / 60000) : SLOT_MINS,
    hasCalendarEvent: !!ev
  };
}

function adminUpdateJob(token, form) {
  requireOwner();
  form = form || {};
  var built = buildAdminBooking_(form);
  if (built.error) return { ok: false, error: built.error };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: "Busy, try again in a moment." }; }
  try {
    var row = findBookingByToken(token);
    if (!row) return { ok: false, error: "Couldn't find that job." };
    var v = row.values;
    if (v["Cancelled at"]) return { ok: false, error: "This booking is cancelled." };
    if (v["Completed at"]) return { ok: false, error: "This job is already signed off, so it can't be changed." };
    var d = built.data;
    var ref = v.Reference;
    var ev = findBookingEvent_(ref, sheetStart_(v));
    var clashes = clashesFor_(built.start, built.end, ev);
    if (clashes.length && !form.force) return { ok: false, needsConfirm: true, clashes: clashes };

    var oldStart = ev ? ev.getStartTime() : sheetStart_(v);
    var timeChanged = !oldStart || oldStart.getTime() !== built.start.getTime() || (ev && ev.getEndTime().getTime() !== built.end.getTime());
    var dayChanged = !oldStart || Utilities.formatDate(oldStart, TIMEZONE, "yyyy-MM-dd") !== Utilities.formatDate(built.start, TIMEZONE, "yyyy-MM-dd");
    var oldTotal = String(v.Total || ""), oldItems = String(v.Items || "");
    // Keep "Booked via" as it was (a website booking stays a website booking).
    d.bookedVia = v["Booked via"] || "Website";

    var changes = [];
    if (oldStart && timeChanged) changes.push("time " + fmtWhen(oldStart) + " to " + fmtWhen(built.start));
    if (oldTotal !== d.total) changes.push("total " + oldTotal + " to " + d.total);
    else if (oldItems !== d.items) changes.push("items");
    ["Name", "Phone", "Email", "Address", "Payment method"].forEach(function (h) {
      var key = { "Name": "name", "Phone": "phone", "Email": "email", "Address": "address", "Payment method": "payment" }[h];
      var before = h === "Phone" ? phoneText(v[h]) : String(v[h] || "");
      if (before !== d[key]) changes.push(h.toLowerCase());
    });
    var reason = String(form.changeReason || "").trim().slice(0, 120);

    var jobLink = adminJobLink(v["Job token"], ref);
    if (ev) {
      ev.setTitle(bookingEventTitle_(d));
      ev.setDescription(bookingEventDescription_(d, ref, jobLink));
      ev.setLocation(d.address);
      if (timeChanged) ev.setTime(built.start, built.end);
    } else {
      CalendarApp.getDefaultCalendar().createEvent(bookingEventTitle_(d), built.start, built.end, {
        description: bookingEventDescription_(d, ref, jobLink), location: d.address
      });
    }

    var sheet = getCustomerSheet();
    var header = ensureColumns(sheet, ["Notes", "Changes", "Booked via", "Access"].concat(START_COLUMNS));
    var log = String(v.Changes || "");
    var entry = Utilities.formatDate(new Date(), TIMEZONE, "d MMM") + ": " + (changes.length ? changes.join(", ") : "details") + (reason ? " (" + reason + ")" : "");
    var writes = {
      "Name": d.name, "Phone": d.phone, "Email": d.email, "Address": d.address,
      "Items": d.items, "Total": d.total, "Payment method": d.payment,
      "Booking time": fmtWhen(built.start),
      "Starts at": built.start, "Ends at": built.end,
      "Business name": d.channel === "Agent/Landlord" ? d.businessName : "",
      "Site contact name": d.channel === "Agent/Landlord" && !d.accessArrange ? d.siteContactName : "",
      "Site contact phone": d.channel === "Agent/Landlord" && !d.accessArrange ? d.siteContactPhone : "",
      "Agent/Agency ID": d.agencyId, "Access": d.channel === "Agent/Landlord" ? accessLabel(d) : "",
      "Referral / offer code": d.referralCode, "Notes": d.notes, "Channel": d.channel,
      "Changes": (log ? log + "; " : "") + entry
    };
    // A job moved to another day gets its reminders again on the new dates.
    if (dayChanged) { writes["Day-before reminder sent"] = ""; writes["Day-of reminder sent"] = ""; }
    setRowValues_(sheet, row.rowIndex, header, writes);
    try { refreshSlotsCache(); } catch (err) { console.error("Cache refresh after editing a job failed: " + err); }

    var emailed = false, emailError = "";
    if (form.emailCustomer && d.email) {
      try { sendBookingUpdateEmail_(d, ref, built.start, v[MANAGE_TOKEN_COLUMN]); emailed = true; }
      catch (err) { emailError = String(err); console.error("Booking update email failed for " + ref + ": " + err); }
    }
    return { ok: true, reference: ref, changes: changes, emailed: emailError ? false : emailed, emailError: emailError };
  } finally {
    lock.releaseLock();
  }
}

// manageToken: the booking's own change-or-cancel link, so this email has
// the Change or cancel button like the confirmation and day-before emails.
function sendBookingUpdateEmail_(d, reference, start, manageToken) {
  var isAgent = d.channel === "Agent/Landlord";
  var name = d.name;
  var manageUrl = manageLink_(manageToken);
  var waLink = "https://wa.me/" + WHATSAPP_NUMBER + "?text=" +
    encodeURIComponent("Hi EasyClean Somerset, about my booking. Ref: " + reference);
  var details = "Here are the updated details for your booking (ref " + reference + "). When: " + fmtWhen(start) +
    ". What: " + d.items + ". Total: " + d.total + " (" + d.payment + "). Where: " + d.address + "." +
    (isAgent ? " Access: " + accessEmailText(d) + "." : "");
  var help = "If anything looks wrong, or you need to change or cancel, " +
    (manageUrl ? "use the button below, reply to this email, or" : "reply to this email, or");
  var text = "Hi " + name + ",\n\n" + details + "\n\n" +
    (manageUrl ? "If anything looks wrong, or you need to change or cancel, do it online: " + manageUrl + "\nOr reply to this email, or WhatsApp us: " + waLink
               : "If anything looks wrong, just reply to this email or WhatsApp us: " + waLink) +
    "\n\nThanks,\nEasyClean Somerset";
  sendCustomerEmail_(d.email, "Booking updated: " + fmtWhen(start) + " (" + reference + ")", text, {
    htmlBody: buildSimpleEmailHtml({
      name: name,
      heading: "Your booking has been updated",
      paragraphs: [{ text: details }, { text: help, link: { label: "message us on WhatsApp", url: waLink } }],
      button: manageUrl ? { text: "Change or cancel", url: manageUrl } : null
    }),
    name: "EasyClean Somerset"
  });
}

// ============================================================
// Customers changing or cancelling online (FRE-211, FRE-213)
// ============================================================
// Every booking gets a second random token, the "Manage token", separate
// from the Job token used for signing off. The Change or cancel button in
// the customer's emails opens my-booking.html?t=<manage token> on the
// website, which makes the four public calls below. The token only ever
// shows, moves or cancels that one booking: it can't sign off a job or open
// the admin app, and the replies hold nothing the customer didn't give us
// (no email, phone, full address or notes).
//
// Rules (FRE-211):
//   - changes are allowed until the clean starts, never after it's
//     cancelled or signed off;
//   - at most MAX_ONLINE_MOVES online moves per booking;
//   - a new time follows the same rules as a new booking (21 days ahead,
//     at least 24 hours' notice, no Sundays or closed days, the job's own
//     length free in the calendar);
//   - a homeowner moving into their 14-day cancellation period has to tick
//     the early-start box if they haven't already. The 14 days still run
//     from the day they booked;
//   - online cancellations never carry a fee;
//   - every cancel or move emails the customer and you.
var MANAGE_TOKEN_COLUMN = "Manage token";
var ONLINE_MOVES_COLUMN = "Online moves";
var MAX_ONLINE_MOVES = 2;
var MANAGE_PAGE_URL = SITE_URL + "/my-booking.html";
var ONLINE_CANCEL_REASONS = ["Plans changed", "Booked someone else", "Price", "Other"];

function manageLink_(token) {
  return isPlausibleToken(token) ? MANAGE_PAGE_URL + "?t=" + encodeURIComponent(token) : "";
}

// The "Need to change anything?" line in plain-text emails.
function changeText_(manageUrl, waLink, oldLine) {
  if (!manageUrl) return oldLine + waLink;
  return "Need to change or cancel? Do it online: " + manageUrl + "\nOr reply to this email, or WhatsApp us: " + waLink;
}

// The button pair for the confirmation and reminder emails.
function changeCtaHtml_(manageUrl, waLink) {
  var SANS = "Arial,Helvetica,sans-serif", TEAL = "#0E7C86", ON_INK = "#F5F7F6", SLATE = "#5C6F73";
  var btn = "display:inline-block;font-family:'Public Sans'," + SANS + ";font-weight:700;font-size:14.5px;text-decoration:none;border-radius:3px;margin:0 4px 8px;";
  return '<p style="margin:0 0 16px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Need to change or cancel? Do it online, reply to this email, or message us:</p>' +
    '<a href="' + escHtml(manageUrl) + '" style="' + btn + 'background:' + TEAL + ';color:' + ON_INK + ';padding:12px 24px;border:2px solid ' + TEAL + ';">Change or cancel</a>' +
    '<a href="' + waLink + '" style="' + btn + 'background:#FFFFFF;color:' + TEAL + ';padding:12px 24px;border:2px solid ' + TEAL + ';">WhatsApp us</a>';
}

// The booking, its calendar event and start time, or null.
function loadManagedBooking_(token) {
  var row = findBookingByTokenColumn_(MANAGE_TOKEN_COLUMN, token);
  if (!row) return null;
  var v = row.values;
  var ev = findBookingEvent_(v.Reference, sheetStart_(v));
  // If the event was deleted by hand, the time saved in the sheet stands in.
  return { row: row, v: v, ev: ev, start: ev ? ev.getStartTime() : sheetStart_(v), end: ev ? ev.getEndTime() : sheetEnd_(v) };
}

// Why this booking can't be changed online, or null if it can.
function notChangeableReason_(b, now) {
  var v = b.v;
  if (v["Cancelled at"]) return "cancelled";
  if (v["Completed at"]) return "completed";
  if (validDate_(v["Started at"])) return "started";
  if (b.start && b.start.getTime() <= now.getTime()) return "started";
  return null;
}

function onlineMovesSoFar_(v) {
  var n = parseInt(v[ONLINE_MOVES_COLUMN], 10);
  return n > 0 ? n : 0;
}

function jobLengthMins_(b) {
  return b.start && b.end ? Math.round((b.end.getTime() - b.start.getTime()) / 60000) : SLOT_MINS;
}

// A homeowner's last day to cancel (yyyy-MM-dd), 14 days from the day they
// booked, worked out the same way as the confirmation email. Null for
// agents, or if the booking date can't be read.
function cancelDeadlineIso_(v) {
  if (v.Channel === "Agent/Landlord") return null;
  var booked = validDate_(v.Timestamp);
  if (!booked) return null;
  var p = Utilities.formatDate(booked, TIMEZONE, "yyyy-MM-dd").split("-");
  var lastDay = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + CANCEL_DAYS, 12));
  return Utilities.formatDate(lastDay, TIMEZONE, "yyyy-MM-dd");
}

function earlyStartGiven_(v) {
  // The old column name is read too, until the sheet has been renamed.
  return /^Yes/.test(String(v[EARLY_START_COLUMN] || v[EARLY_START_OLD_COLUMN] || ""));
}

// "Mon 12 Oct at 9:00am"
function whenLabel_(d) {
  return Utilities.formatDate(d, TIMEZONE, "EEE d MMM 'at' h:mma").replace("AM", "am").replace("PM", "pm");
}

// First line of the address and the postcode district: "12 Ivy Walk, BA3".
function shortAddress_(address) {
  var a = String(address || "").trim();
  var first = a.split(",")[0].trim();
  var m = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\s*$/i.exec(a);
  if (!m) return first;
  var district = m[1].toUpperCase();
  return first.toUpperCase().replace(/\s/g, "").indexOf(district) === 0 ? district : first + ", " + district;
}

// "2× Medium room: £90, 1× Armchair: £15" -> [{ name, qty }]
function publicItems_(items) {
  return String(items || "").split(", ").filter(function (x) { return x; }).map(function (part) {
    var cut = part.lastIndexOf(": ");
    var left = (cut === -1 ? part : part.slice(0, cut)).trim();
    var m = /^(\d+)\s*[×x]\s*(.+)$/.exec(left);
    return m ? { name: m[2].trim(), qty: parseInt(m[1], 10) } : { name: left, qty: 1 };
  });
}

// GET ?action=booking&t=...
function getPublicBooking(token) {
  var b = loadManagedBooking_(token);
  if (!b) return { ok: false, error: "not_found" };
  var v = b.v;
  var reason = notChangeableReason_(b, new Date());
  var isAgent = v.Channel === "Agent/Landlord";
  var plain = function (x) { return x instanceof Date ? fmtWhen(x) : String(x === undefined || x === null ? "" : x); };
  var est = parseInt(v["Est. mins"], 10);
  return {
    ok: true,
    reference: plain(v.Reference),
    channel: isAgent ? "agent" : "homeowner",
    date: b.start ? Utilities.formatDate(b.start, TIMEZONE, "yyyy-MM-dd") : "",
    time: b.start ? Utilities.formatDate(b.start, TIMEZONE, "HH:mm") : "",
    whenLabel: b.start ? whenLabel_(b.start) : bookingTimeText(v),
    addressShort: shortAddress_(plain(v.Address)),
    items: publicItems_(plain(v.Items)),
    total: plain(v.Total),
    estMins: est > 0 ? est : jobLengthMins_(b),
    // No calendar event (deleted by hand): the page says to message us.
    canChange: !reason && !!b.start,
    notChangeableReason: reason,
    movesLeft: Math.max(0, MAX_ONLINE_MOVES - onlineMovesSoFar_(v)),
    cancelDeadline: isAgent ? null : cancelDeadlineIso_(v),
    earlyStartGiven: isAgent ? false : earlyStartGiven_(v)
  };
}

// GET ?action=rescheduleSlots&t=... Same shape as ?action=slots.
function getRescheduleSlots(token) {
  var b = loadManagedBooking_(token);
  if (!b) return { ok: false, error: "not_found" };
  var reason = notChangeableReason_(b, new Date());
  if (reason) return { ok: false, error: reason };
  if (!b.start) return { ok: false, error: "not_found" };
  if (onlineMovesSoFar_(b.v) >= MAX_ONLINE_MOVES) return { ok: false, error: "no_moves_left" };
  var slots = computeSlots_({ ignoreReference: b.v.Reference, lengthMins: jobLengthMins_(b), skipStartMs: b.start.getTime() });
  slots.forEach(function (s) { s.timeLabel = s.timeLabel.replace("AM", "am").replace("PM", "pm"); });
  return { ok: true, slots: slots };
}

// POST { action: "cancel", t, reason }
function cancelBookingPublic(data) {
  data = data || {};
  if (!isPlausibleToken(data.t)) return { ok: false, error: "not_found" };
  var reasonText = ONLINE_CANCEL_REASONS.indexOf(data.reason) !== -1 ? data.reason : "";
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: "busy" }; }
  try {
    var b = loadManagedBooking_(data.t);
    if (!b) return { ok: false, error: "not_found" };
    var now = new Date();
    var why = notChangeableReason_(b, now);
    if (why) return { ok: false, error: why };
    var v = b.v;
    var whenStr = b.start ? fmtWhen(b.start) : bookingTimeText(v);
    var late = !!b.start && isLateCancellation(b.start, now);
    var res = cancelJobLocked_(v["Job token"], {
      row: b.row,
      reason: "customer",
      cancelledBy: "Customer (online" + (reasonText ? ": " + reasonText : "") + ")",
      note: "Cancelled by the customer with the link in their emails.",
      emailCustomer: false,
      chargeFee: false
    });
    if (!res.ok) throw new Error(res.error || "cancel failed");

    if (v.Email) {
      try {
        sendCancellationEmail(v, "online", whenStr, null, now);
      } catch (err) {
        noteProblem_("Online cancellation email failed for " + v.Reference, err);
        notifyOwner("Cancellation email failed for " + v.Reference,
          "The customer cancelled online and the booking is cancelled, but the email confirming it didn't send (" + err + "). " +
          "The law asks us to confirm an online cancellation in writing, so please email or message them.");
      }
    }
    notifyOwner("Cancelled online: " + v.Reference + ", " + whenStr, [
      (v["Business name"] && v.Channel === "Agent/Landlord" ? v.Name + " (" + v["Business name"] + ")" : v.Name) + " cancelled their booking using the link in their emails.",
      "",
      "Was: " + whenStr,
      "Where: " + v.Address,
      "What: " + v.Items + " (" + v.Total + ")",
      "Reason given: " + (reasonText || "none"),
      late ? "Notice: less than 24 hours. Online cancellations never carry a fee." : null,
      "",
      "The time is free again on the website. " + (v.Email ? "They've been emailed to confirm." : "They have no email address, so nothing was sent to them.")
    ].filter(function (x) { return x !== null; }).join("\n"));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// POST { action: "reschedule", t, date: "yyyy-MM-dd", time: "HH:mm", earlyStart }
function rescheduleBookingPublic(data) {
  data = data || {};
  if (!isPlausibleToken(data.t)) return { ok: false, error: "not_found" };
  var day = parseIsoDate_(data.date), hm = parseHhmm_(data.time);
  if (!day || !hm) return { ok: false, error: "slot_taken" };
  var newStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hm.h, hm.m);
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: "busy" }; }
  try {
    var b = loadManagedBooking_(data.t);
    if (!b) return { ok: false, error: "not_found" };
    var now = new Date();
    var why = notChangeableReason_(b, now);
    if (why) return { ok: false, error: why };
    if (!b.start) return { ok: false, error: "not_found" };
    var v = b.v;
    var reply = function (d) {
      return { ok: true, date: Utilities.formatDate(d, TIMEZONE, "yyyy-MM-dd"), time: Utilities.formatDate(d, TIMEZONE, "HH:mm"), whenLabel: whenLabel_(d) };
    };
    if (newStart.getTime() === b.start.getTime()) return reply(b.start); // nothing to move
    var moves = onlineMovesSoFar_(v);
    if (moves >= MAX_ONLINE_MOVES) return { ok: false, error: "no_moves_left" };

    var newEnd = new Date(newStart.getTime() + jobLengthMins_(b) * 60000);
    if (!isOfferableSlot(newStart) || clashesFor_(newStart, newEnd, b.ev).length) return { ok: false, error: "slot_taken" };

    var newDay = Utilities.formatDate(newStart, TIMEZONE, "yyyy-MM-dd");
    var deadline = v.Channel === "Agent/Landlord" ? null : cancelDeadlineIso_(v);
    var newlyGiven = false;
    if (deadline && newDay <= deadline && !earlyStartGiven_(v)) {
      if (data.earlyStart !== true) return { ok: false, error: "needs_early_start" };
      newlyGiven = true;
    }

    var oldStart = b.start;
    if (b.ev) b.ev.setTime(newStart, newEnd);
    else createEventForRow_(v, newStart, newEnd); // its event had been deleted by hand
    var dayChanged = Utilities.formatDate(oldStart, TIMEZONE, "yyyy-MM-dd") !== newDay;

    var entry = Utilities.formatDate(now, TIMEZONE, "d MMM") + ": moved online by customer from " + fmtWhen(oldStart) + " to " + fmtWhen(newStart);
    try {
      var sheet = getCustomerSheet();
      var header = ensureColumns(sheet, ["Changes", ONLINE_MOVES_COLUMN, EARLY_START_COLUMN].concat(START_COLUMNS));
      var log = String(v.Changes || "");
      var writes = { "Booking time": fmtWhen(newStart), "Starts at": newStart, "Ends at": newEnd, "Changes": (log ? log + "; " : "") + entry };
      writes[ONLINE_MOVES_COLUMN] = moves + 1;
      if (newlyGiven) writes[EARLY_START_COLUMN] = EARLY_START_VALUES.moved;
      // A job moved to another day gets its reminders again on the new dates.
      if (dayChanged) {
        if (header.indexOf("Day-before reminder sent") !== -1) writes["Day-before reminder sent"] = "";
        if (header.indexOf("Day-of reminder sent") !== -1) writes["Day-of reminder sent"] = "";
      }
      setRowValues_(sheet, b.row.rowIndex, header, writes);
    } catch (sheetErr) {
      noteProblem_("Recording an online move failed for " + v.Reference, sheetErr);
      notifyOwner("Customer sheet not updated for " + v.Reference,
        "The customer moved their booking online and the calendar now shows " + fmtWhen(newStart) + ", but the customer sheet couldn't be updated (" + sheetErr + "). " +
        "Update Booking time and Changes by hand.");
    }
    try { refreshSlotsCache(); } catch (err) { noteProblem_("Refreshing available times after an online move failed", err); }

    if (v.Email) {
      try {
        sendBookingMovedEmail_(v, oldStart, newStart);
      } catch (err) {
        noteProblem_("'Booking moved' email failed for " + v.Reference, err);
      }
    }
    notifyOwner("Moved online: " + v.Reference + " to " + fmtWhen(newStart), [
      (v["Business name"] && v.Channel === "Agent/Landlord" ? v.Name + " (" + v["Business name"] + ")" : v.Name) + " moved their booking using the link in their emails.",
      "",
      "From: " + fmtWhen(oldStart),
      "To: " + fmtWhen(newStart),
      "Where: " + v.Address,
      "What: " + v.Items + " (" + v.Total + ")",
      newlyGiven ? "They ticked the box asking us to clean within their 14-day cancellation period." : null,
      "Online moves used: " + (moves + 1) + " of " + MAX_ONLINE_MOVES + ".",
      "",
      "Your calendar is updated. " + (v.Email ? "They've been emailed the new time." : "They have no email address, so nothing was sent to them.")
    ].filter(function (x) { return x !== null; }).join("\n"));
    return reply(newStart);
  } finally {
    lock.releaseLock();
  }
}

function sendBookingMovedEmail_(v, oldStart, newStart) {
  var isAgent = v.Channel === "Agent/Landlord";
  var name = isAgent ? (v.Name || v["Business name"]) : v.Name;
  var manageUrl = manageLink_(v[MANAGE_TOKEN_COLUMN]);
  var waLink = "https://wa.me/" + WHATSAPP_NUMBER + "?text=" +
    encodeURIComponent("Hi EasyClean Somerset, about my booking. Ref: " + v.Reference);
  var moved = "Your booking (ref " + v.Reference + ") has moved from " + fmtWhen(oldStart) + " to " + fmtWhen(newStart) + ".";
  var details = "What: " + v.Items + ". Total: " + v.Total + ". Where: " + v.Address + ".";
  var help = "Need to change it again, or cancel? " + (manageUrl ? "Use the button below, reply to this email, or" : "Reply to this email, or");
  var text = "Hi " + name + ",\n\n" + moved + "\n\n" + details + "\n\n" +
    (manageUrl ? "Need to change it again, or cancel? Do it online: " + manageUrl + "\nOr reply to this email, or WhatsApp us: " + waLink
               : "Need to change it again, or cancel? Reply to this email or WhatsApp us: " + waLink) +
    "\n\nThanks,\nEasyClean Somerset";
  sendCustomerEmail_(v.Email, "Booking moved: " + fmtWhen(newStart) + " (" + v.Reference + ")", text, {
    htmlBody: buildSimpleEmailHtml({
      name: name,
      heading: "Your booking has moved",
      paragraphs: [{ text: moved }, { text: details }, { text: help, link: { label: "message us on WhatsApp", url: waLink } }],
      button: manageUrl ? { text: "Change or cancel", url: manageUrl } : null
    }),
    name: "EasyClean Somerset"
  });
}

/**
 * Run once after pasting the FRE-213 version (function dropdown -> Run).
 * Gives every booking that isn't cancelled or signed off a manage token, so
 * its next reminder email has the Change or cancel button. Safe to run again.
 */
function setUpManageTokens() {
  var sheet = getCustomerSheet();
  if (!sheet) { Logger.log("Customer sheet not set up."); return; }
  var header = ensureColumns(sheet, [MANAGE_TOKEN_COLUMN]);
  var col = header.indexOf(MANAGE_TOKEN_COLUMN);
  var data = sheet.getDataRange().getValues();
  var refCol = header.indexOf("Reference"), cancelCol = header.indexOf("Cancelled at"), doneCol = header.indexOf("Completed at");
  var added = 0;
  for (var i = 1; i < data.length; i++) {
    if (!data[i][refCol] || data[i][col]) continue;
    if ((cancelCol !== -1 && data[i][cancelCol]) || (doneCol !== -1 && data[i][doneCol])) continue;
    var cell = sheet.getRange(i + 1, col + 1);
    cell.setNumberFormat("@");
    cell.setValue(newJobToken());
    added++;
  }
  Logger.log("Manage tokens added to " + added + " booking(s).");
  return added;
}

// ---- Time off: blocking days or hours from the admin app ----
// A block is just a calendar event (title "Blocked: ...", tagged in its
// description), so the existing clash check keeps those times off the
// website, and it shows in your calendar like anything else.
var BLOCK_TAG = "Added from the EasyClean admin app (Time off).";

function parseIsoDate_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function parseHhmm_(hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return { h: +m[1], m: +m[2] };
}

function isBlockEvent_(ev) {
  return String(ev.getDescription() || "").indexOf(BLOCK_TAG) !== -1;
}

function blockLabel_(ev) {
  var start = ev.getStartTime(), end = ev.getEndTime();
  var day = function (d) { return Utilities.formatDate(d, TIMEZONE, "EEE d MMM"); };
  var time = function (d) { return Utilities.formatDate(d, TIMEZONE, "h:mma").replace("AM", "am").replace("PM", "pm"); };
  if (ev.isAllDayEvent()) {
    var last = new Date(end.getTime() - 86400000);
    return day(start) === day(last) ? day(start) + ", all day" : day(start) + " to " + day(last) + ", all day";
  }
  return day(start) + ", " + time(start) + " to " + time(end);
}

function adminListBlocks() {
  requireOwner();
  var now = new Date();
  var blocks = CalendarApp.getDefaultCalendar()
    .getEvents(new Date(now.getFullYear(), now.getMonth(), now.getDate()), new Date(now.getTime() + 365 * 86400000))
    .filter(isBlockEvent_)
    .map(function (ev) {
      return { id: ev.getId(), label: blockLabel_(ev), note: String(ev.getTitle() || "").replace(/^Blocked:\s*/, ""), sort: ev.getStartTime().getTime() };
    });
  blocks.sort(function (a, b) { return a.sort - b.sort; });
  return { ok: true, blocks: blocks.map(function (b) { delete b.sort; return b; }) };
}

// opts: { date: "yyyy-mm-dd", untilDate: "yyyy-mm-dd" (optional, all-day only),
//         allDay: true/false, from: "HH:mm", to: "HH:mm", note }
function adminAddBlock(opts) {
  requireOwner();
  opts = opts || {};
  var first = parseIsoDate_(opts.date);
  if (!first) return { ok: false, error: "Pick a date." };
  var note = String(opts.note || "").trim().slice(0, 80);
  var title = "Blocked: " + (note || (opts.allDay ? "day off" : "time off"));
  var cal = CalendarApp.getDefaultCalendar();
  var start, end;
  if (opts.allDay) {
    var last = opts.untilDate ? parseIsoDate_(opts.untilDate) : first;
    if (!last || last < first) return { ok: false, error: "The end date is before the start date." };
    if ((last - first) / 86400000 > 60) return { ok: false, error: "That's more than 60 days. Add it in two parts." };
    start = first;
    end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    cal.createAllDayEvent(title, start, end, { description: BLOCK_TAG });
  } else {
    var f = parseHhmm_(opts.from), t = parseHhmm_(opts.to);
    if (!f || !t) return { ok: false, error: "Pick a start and end time." };
    start = new Date(first.getFullYear(), first.getMonth(), first.getDate(), f.h, f.m);
    end = new Date(first.getFullYear(), first.getMonth(), first.getDate(), t.h, t.m);
    if (end <= start) return { ok: false, error: "The end time is before the start time." };
    cal.createEvent(title, start, end, { description: BLOCK_TAG });
  }
  try { refreshSlotsCache(); } catch (err) { console.error("Cache refresh after blocking time failed: " + err); }
  // Bookings already in that time aren't touched; say so, so they can be
  // moved or cancelled separately.
  var clashes = cal.getEvents(start, end).map(referenceFromEvent).filter(function (r) { return r; });
  return { ok: true, clashes: clashes };
}

function adminRemoveBlock(id) {
  requireOwner();
  var ev = CalendarApp.getDefaultCalendar().getEventById(String(id || ""));
  if (!ev || !isBlockEvent_(ev)) return { ok: false, error: "Couldn't find that block." };
  ev.deleteEvent();
  try { refreshSlotsCache(); } catch (err) { console.error("Cache refresh after removing a block failed: " + err); }
  return { ok: true };
}

// ---- Unpaid invoices: reminder to the payer, and Niall's Monday digest ----

// Who an unpaid invoice is chased with: the booker, plus the agency's
// accounts email for agents (if it's on the Agencies tab and different).
function sendPaymentReminderEmail(v) {
  var isAgent = v.Channel === "Agent/Landlord";
  var name = isAgent ? (v.Name || v["Business name"]) : v.Name;
  var invoiceNo = formatInvoiceNo(v["Invoice number"]);
  var amount = v["Cancellation fee"] || v.Total;
  var due = v["Payment due"] instanceof Date ? Utilities.formatDate(v["Payment due"], TIMEZONE, "d MMMM yyyy") : "";
  var bank = getBankDetails();
  var body = "Just a friendly reminder that invoice " + invoiceNo + " for " + amount +
    " (" + v.Address + ", our ref " + v.Reference + ")" + (due ? " was due on " + due : " is due") + ". " +
    (bank.complete
      ? "You can pay by bank transfer to " + bank.accountName + ", sort code " + bank.sortCode + ", account " + bank.accountNumber + ", using " + invoiceNo + " as the reference."
      : "Please use " + invoiceNo + " as the payment reference, and reply to this email if you need our bank details.") +
    " If you've already paid, thank you, and please ignore this.";
  var opts = {
    htmlBody: buildSimpleEmailHtml({ name: name, heading: "Payment reminder: " + invoiceNo, body: body }),
    name: "EasyClean Somerset"
  };
  var pdf = invoicePdfFromDrive(v["Invoice PDF"]);
  if (pdf) opts.attachments = [pdf];
  if (isAgent) {
    try {
      var agency = getAgencyBilling(v["Business name"]);
      if (agency.accountsEmail && agency.accountsEmail.toLowerCase() !== String(v.Email).toLowerCase()) opts.cc = agency.accountsEmail;
    } catch (err) { /* reminder still goes to the booker */ }
  }
  sendCustomerEmail_(v.Email, "Payment reminder: " + invoiceNo + " (" + amount + ")", "Hi " + name + ",\n\n" + body + "\n\nThanks,\nEasyClean Somerset", opts);
}

// The saved invoice PDF, re-attached to a reminder. Null if it can't be read.
function invoicePdfFromDrive(url) {
  var m = String(url || "").match(/\/d\/([\w-]{10,})|[?&]id=([\w-]{10,})/);
  if (!m) return null;
  try {
    return DriveApp.getFileById(m[1] || m[2]).getBlob();
  } catch (err) {
    noteProblem_("Couldn't attach an invoice PDF", err);
    return null;
  }
}

function adminSendPaymentReminder(token) {
  requireOwner();
  var row = findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  var v = row.values;
  if (!v["Payment due"] || v["Paid on"]) return { ok: false, error: "This invoice isn't unpaid." };
  if (!v.Email) return { ok: false, error: "No email address on this booking." };
  sendPaymentReminderEmail(v);
  var sheet = getCustomerSheet();
  var header = ensureColumns(sheet, ["Payment reminder sent"]);
  var now = new Date();
  sheet.getRange(row.rowIndex, header.indexOf("Payment reminder sent") + 1).setValue(now);
  return { ok: true, remindedOn: fmtDay(now) };
}

// Monday morning email to Niall: overdue invoices and those due this week.
// Sent only when there's something on the list.
function sendUnpaidDigest() {
  var sheet = getCustomerSheet();
  if (!sheet) return false;
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var now = new Date();
  var weekAhead = now.getTime() + 7 * 86400000;
  var overdue = [], dueSoon = [];
  for (var i = 1; i < data.length; i++) {
    var v = rowToObject(header, data[i]);
    if (!v.Reference || !(v["Payment due"] instanceof Date) || v["Paid on"]) continue;
    var due = v["Payment due"];
    var who = v.Channel === "Agent/Landlord" ? v["Business name"] : v.Name;
    var line = formatInvoiceNo(v["Invoice number"]) + "  " + who + "  " + (v["Cancellation fee"] || v.Total);
    // Compare by calendar day, so something due today isn't "overdue".
    if (dayKey(due) < dayKey(now)) {
      var days = Math.floor((now - due) / 86400000);
      overdue.push({ sort: due.getTime(), text: line + "  (" + days + (days === 1 ? " day" : " days") + " overdue" +
        (v["Payment reminder sent"] instanceof Date ? ", reminded " + fmtDay(v["Payment reminder sent"]) : "") + ")" });
    } else if (due.getTime() <= weekAhead) {
      dueSoon.push({ sort: due.getTime(), text: line + "  (due " + fmtDay(due) + ")" });
    }
  }
  if (!overdue.length && !dueSoon.length) return false;
  var bySort = function (a, b) { return a.sort - b.sort; };
  overdue.sort(bySort); dueSoon.sort(bySort);
  var lines = [];
  if (overdue.length) lines.push("Overdue:", overdue.map(function (o) { return "  " + o.text; }).join("\n"), "");
  if (dueSoon.length) lines.push("Due in the next 7 days:", dueSoon.map(function (o) { return "  " + o.text; }).join("\n"), "");
  var adminUrl = getAdminUrl();
  lines.push(adminUrl ? "Mark them paid or send a reminder in the admin app (Unpaid tab): " + adminUrl : "Mark them paid or send a reminder in the admin app's Unpaid tab.");
  notifyOwner("Unpaid invoices: " + overdue.length + " overdue" + (dueSoon.length ? ", " + dueSoon.length + " due this week" : ""), lines.join("\n"));
  return true;
}

// ---- Monthly figures and the Income column (FRE-187) ----
// A cancelled booking keeps its original Total in the sheet next to the £25
// fee, so adding up the Total column overstates income. The "Income" column
// holds what each signed-off job or cancellation really adds, so it adds up
// correctly. It is filled in at sign-off and at cancellation.
//
// The figures email (first of the month, from the daily trigger) and the
// admin app's Figures tab work the same numbers out from the sheet. Income is
// counted on the day a job is signed off, or a cancellation fee invoiced, not
// the day it is paid. What is still unpaid is shown separately.

var INCOME_COLUMN = "Income";
var VAT_THRESHOLD = 90000;            // turnover over any 12 months that means registering for VAT
var FIGURES_YEAR = "tax";             // "tax" counts the year to date from 6 April, "calendar" from 1 January
var FIGURES_TARGET_AVG_JOB = 140;     // business plan targets
var FIGURES_TARGET_JOBS_WEEK = "5 to 7";
var FIGURES_LAST_MONTH_KEY = "FIGURES_LAST_MONTH"; // the last month already emailed, "yyyy-MM"
var FIGURE_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// What a signed-off job adds: its total, or nothing for a "No charge" job.
function jobIncomeAmount_(v) {
  if (/no charge/i.test(String(v["Payment method"] || ""))) return 0;
  var n = parseMoney_(v.Total);
  return n === null || n < 0 ? 0 : n;
}

// What one row adds to the books, and the day it counts on ("yyyy-MM-dd"),
// or null if it isn't done yet. A cancelled booking adds its fee (if one was
// charged), never its total.
function incomeFor_(v) {
  if (v["Cancelled at"]) {
    var c = validDate_(v["Cancelled at"]);
    var fee = parseMoney_(v["Cancellation fee"]);
    return { amount: fee > 0 ? fee : 0, key: c ? dayKey(c) : "", kind: "cancelled" };
  }
  if (v["Completed at"]) {
    var d = validDate_(v["Completed at"]);
    return { amount: jobIncomeAmount_(v), key: d ? dayKey(d) : "", kind: "job" };
  }
  return null;
}

function writeIncome_(sheet, rowIndex, amount) {
  var header = ensureColumns(sheet, [INCOME_COLUMN]);
  var cell = sheet.getRange(rowIndex, header.indexOf(INCOME_COLUMN) + 1);
  cell.setNumberFormat("£#,##0.00");
  cell.setValue(amount);
}

function readFigureRows_(sheet) {
  var data = sheet.getDataRange().getValues();
  var header = data[0], rows = [];
  for (var i = 1; i < data.length; i++) {
    var v = rowToObject(header, data[i]);
    if (v.Reference) rows.push(v);
  }
  return rows;
}

// ---- Dates as "yyyy-MM-dd" keys in the business's time zone ----
function pad2_(n) { return (n < 10 ? "0" : "") + n; }
function keyUtc_(key) { var p = key.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function keyFromUtc_(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad2_(d.getUTCMonth() + 1) + "-" + pad2_(d.getUTCDate()); }
function addDaysKey_(key, n) { return keyFromUtc_(keyUtc_(key) + n * 86400000); }
function keyDays_(a, b) { return Math.round((keyUtc_(b) - keyUtc_(a)) / 86400000); }
// The first of the month, `offset` months from the one `key` is in.
function monthStartKey_(key, offset) {
  var p = key.split("-");
  return keyFromUtc_(Date.UTC(+p[0], +p[1] - 1 + offset, 1));
}
function yearStartKey_(todayKey) {
  var p = todayKey.split("-"), y = +p[0];
  if (FIGURES_YEAR === "calendar") return y + "-01-01";
  return (p[1] + "-" + p[2] >= "04-06" ? y : y - 1) + "-04-06";
}
function monthName_(key) { var p = key.split("-"); return FIGURE_MONTHS[+p[1] - 1] + " " + p[0]; }
function shortDate_(key) { var p = key.split("-"); return (+p[2]) + " " + FIGURE_MONTHS[+p[1] - 1].slice(0, 3) + " " + p[0]; }

// £ with thousands separators, and pence only when there are some.
function gbp_(n) {
  n = Math.round(n * 100) / 100;
  var a = Math.abs(n);
  var s = (a % 1 === 0 ? String(a) : a.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (n < 0 ? "-" : "") + "£" + s;
}

// Everything for one period, from `fromKey` up to but not including `toKey`.
function computePeriod_(rows, fromKey, toKey, label) {
  var inRange = function (k) { return !!k && k >= fromKey && k < toKey; };
  var p = {
    label: label, days: Math.max(1, keyDays_(fromKey, toKey)),
    jobs: 0, paidJobs: 0, jobRevenue: 0, feeCount: 0, feeAmount: 0,
    cancelled: { total: 0, customer: 0, noaccess: 0, us: 0 },
    bookings: { total: 0, consumer: 0, agent: 0, website: 0, admin: 0 },
    referrals: {}, timing: { n: 0, actual: 0, est: 0 }
  };
  rows.forEach(function (v) {
    var inc = incomeFor_(v);
    if (inc && inRange(inc.key)) {
      if (inc.kind === "job") {
        p.jobs++; p.jobRevenue += inc.amount;
        if (inc.amount > 0) p.paidJobs++;
        var actual = parseInt(v["Actual mins"], 10) || 0, est = parseInt(v["Est. mins"], 10) || 0;
        if (actual > 0 && est > 0) { p.timing.n++; p.timing.actual += actual; p.timing.est += est; }
      } else {
        p.cancelled.total++;
        var by = String(v["Cancelled by"] || "");
        if (/^Customer/i.test(by)) p.cancelled.customer++;
        else if (/^No access/i.test(by)) p.cancelled.noaccess++;
        else if (/^We cancelled/i.test(by)) p.cancelled.us++;
        if (inc.amount > 0) { p.feeCount++; p.feeAmount += inc.amount; }
      }
    }
    var made = validDate_(v.Timestamp);
    if (made && inRange(dayKey(made))) {
      p.bookings.total++;
      if (v.Channel === "Agent/Landlord") p.bookings.agent++; else p.bookings.consumer++;
      if (String(v["Booked via"] || "") === "Admin app") p.bookings.admin++; else p.bookings.website++;
      var code = String(v["Referral / offer code"] || "").trim().toUpperCase();
      if (code) p.referrals[code] = (p.referrals[code] || 0) + 1;
    }
  });
  p.income = p.jobRevenue + p.feeAmount;
  return p;
}

// All the periods the email and the Figures tab use, worked out from the rows.
function computeFigures_(rows, now) {
  var today = dayKey(now), tomorrow = addDaysKey_(today, 1);
  var thisMonth = monthStartKey_(today, 0), lastMonth = monthStartKey_(today, -1), yearStart = yearStartKey_(today);
  var p = today.split("-");
  var yearAgo = keyFromUtc_(Date.UTC(+p[0] - 1, +p[1] - 1, +p[2]));
  var f = {
    thisMonth: computePeriod_(rows, thisMonth, tomorrow, "This month so far (" + monthName_(thisMonth) + ")"),
    lastMonth: computePeriod_(rows, lastMonth, thisMonth, monthName_(lastMonth)),
    ytd: computePeriod_(rows, yearStart, tomorrow, "Year to date (since " + shortDate_(yearStart) + ")"),
    rolling: computePeriod_(rows, addDaysKey_(yearAgo, 1), tomorrow, "Last 12 months"),
    unpaid: { count: 0, amount: 0, overdueCount: 0, overdueAmount: 0 },
    noDate: 0
  };
  rows.forEach(function (v) {
    var inc = incomeFor_(v);
    if (inc && !inc.key) f.noDate++;
    if (!v["Payment due"] || v["Paid on"]) return; // the same rule as the admin app's Unpaid tab
    var amount = parseMoney_(v["Cancellation fee"] || v.Total) || 0;
    f.unpaid.count++; f.unpaid.amount += amount;
    var due = validDate_(v["Payment due"]);
    if (due && dayKey(due) < today) { f.unpaid.overdueCount++; f.unpaid.overdueAmount += amount; }
  });
  return f;
}

function listText_(parts) { return parts.length ? parts.join(", ") : ""; }

// The lines for one period as [label, value] pairs.
function periodRows_(p) {
  var rows = [];
  rows.push(["Jobs completed", String(p.jobs)]);
  rows.push(["Job revenue", gbp_(p.jobRevenue)]);
  rows.push(["Cancellation and call-out fees", p.feeCount ? gbp_(p.feeAmount) + " (" + p.feeCount + ")" : "none"]);
  rows.push(["Total income", gbp_(p.income)]);
  rows.push(["Average job", p.paidJobs ? gbp_(Math.round(p.jobRevenue / p.paidJobs)) + " (target " + gbp_(FIGURES_TARGET_AVG_JOB) + ")" : "none yet"]);
  // Too few days to mean anything (one job on the 2nd is not "3.5 a week").
  rows.push(["Jobs a week", p.days < 14 ? "too early to say (target " + FIGURES_TARGET_JOBS_WEEK + ")"
    : (Math.round(p.jobs / (p.days / 7) * 10) / 10) + " (target " + FIGURES_TARGET_JOBS_WEEK + ")"]);
  var c = p.cancelled;
  rows.push(["Cancelled bookings", c.total
    ? c.total + " (" + listText_([c.customer ? "customer " + c.customer : "", c.noaccess ? "no access " + c.noaccess : "", c.us ? "we cancelled " + c.us : ""].filter(String)) + ")"
    : "none"]);
  var b = p.bookings;
  rows.push(["Bookings made", b.total ? b.total + " (homeowner " + b.consumer + ", landlord or agent " + b.agent + ")" : "none"]);
  if (b.total) rows.push(["Booked on", "website " + b.website + ", admin app " + b.admin]);
  var codes = Object.keys(p.referrals).sort(function (x, y) { return p.referrals[y] - p.referrals[x] || (x < y ? -1 : 1); }).slice(0, 8);
  rows.push(["Referral codes", codes.length ? codes.map(function (k) { return k + " x" + p.referrals[k]; }).join(", ") : "none"]);
  var t = p.timing;
  rows.push(["Time on job", t.n
    ? t.n + " timed, average " + formatMinsServer(Math.round(t.actual / t.n)) + " against an estimate of " + formatMinsServer(Math.round(t.est / t.n))
    : "none timed yet"]);
  return rows;
}

// Sections for the email and the Figures tab: { title, rows, note?, bar? }.
function figureSections_(f, withThisMonth) {
  var sections = [];
  if (withThisMonth) sections.push({ title: f.thisMonth.label, rows: periodRows_(f.thisMonth) });
  sections.push({ title: f.lastMonth.label, rows: periodRows_(f.lastMonth) });
  sections.push({ title: f.ytd.label, rows: periodRows_(f.ytd) });
  var turnover = f.rolling.income, pct = Math.round(turnover / VAT_THRESHOLD * 1000) / 10;
  sections.push({
    title: "VAT threshold, last 12 months",
    rows: [["Turnover", gbp_(turnover)], ["Threshold", gbp_(VAT_THRESHOLD)], ["Used", pct + "%"], ["Room left", gbp_(Math.max(0, VAT_THRESHOLD - turnover))]],
    bar: Math.min(100, pct),
    note: "Jobs signed off plus cancellation fees." + (pct >= 80 ? " Over 80% of the threshold: check on GOV.UK when you need to register before you reach it." : "")
  });
  sections.push({
    title: "Unpaid now",
    rows: [["Unpaid invoices", f.unpaid.count ? f.unpaid.count + " (" + gbp_(f.unpaid.amount) + ")" : "none"],
           ["Overdue", f.unpaid.overdueCount ? f.unpaid.overdueCount + " (" + gbp_(f.unpaid.overdueAmount) + ")" : "none"]]
  });
  if (f.noDate) {
    sections.push({ title: "Needs a look", rows: [["Signed-off or cancelled rows with no usable date, left out of the figures", String(f.noDate)]] });
  }
  return sections;
}

function figuresEmailText_(f) {
  var lines = ["These come from your Bookings sheet. Income is counted on the day a job was signed off, or a cancellation fee was invoiced, not the day it was paid.", ""];
  figureSections_(f, false).forEach(function (s) {
    lines.push(s.title.toUpperCase());
    s.rows.forEach(function (r) { lines.push(r[0] + ": " + r[1]); });
    if (s.note) lines.push(s.note);
    lines.push("");
  });
  var url = getAdminUrl();
  lines.push(url ? "More in the admin app (Figures tab): " + url : "More in the admin app's Figures tab.");
  return lines.join("\n");
}

// Emails last month's figures once a month. Called every morning by the daily
// trigger: it sends on the first morning of a new month and does nothing
// after that, and if the 1st was missed it sends on the next morning that
// runs. The first time it ever runs mid-month it only notes the month, so the
// first email is the one on the next 1st. opts.force sends now without
// touching that (see sendFiguresPreview).
function sendMonthlyFigures_(opts) {
  opts = opts || {};
  var now = opts.now || new Date();
  var today = dayKey(now);
  var reportKey = monthStartKey_(today, -1).slice(0, 7);
  var props = PropertiesService.getScriptProperties();
  var last = props.getProperty(FIGURES_LAST_MONTH_KEY);
  if (!opts.force) {
    if (last === reportKey) return false;
    if (!last && today.slice(8) !== "01") { props.setProperty(FIGURES_LAST_MONTH_KEY, reportKey); return false; }
  }
  var sheet = getCustomerSheet();
  if (!sheet) return false;
  var f = computeFigures_(readFigureRows_(sheet), now);
  var p = f.lastMonth;
  var sent = notifyOwner("Figures for " + p.label + ": " + p.jobs + (p.jobs === 1 ? " job, " : " jobs, ") + gbp_(p.income), figuresEmailText_(f));
  if (sent && !opts.force) props.setProperty(FIGURES_LAST_MONTH_KEY, reportKey);
  return sent;
}

/**
 * Run from the editor (function dropdown -> Run) to email yourself last
 * month's figures now, to see what the monthly email looks like. It doesn't
 * stop the real one going out on the 1st.
 */
function sendFiguresPreview() {
  var sent = sendMonthlyFigures_({ force: true });
  Logger.log(sent ? "Figures emailed to you." : "Couldn't send. See the execution log and the customer sheet setup.");
}

// The same numbers for the admin app's Figures tab.
function adminGetFigures() {
  requireOwner();
  var sheet = getCustomerSheet();
  if (!sheet) return { ok: false, error: "no_sheet" };
  var now = new Date();
  return { ok: true, asOf: fmtDay(now), sections: figureSections_(computeFigures_(readFigureRows_(sheet), now), true) };
}

// ---- Cancelling a booking (admin app) ----
// Removes the calendar event (so the slot is offered online again), marks
// the booking cancelled in the sheet, optionally emails the customer, and,
// for a late cancellation or no access, can invoice the £25 fee from the
// terms. The fee invoice uses the job's normal invoice columns, so it shows
// in the Unpaid list and Mark paid / receipts work as usual.

var CANCEL_REASONS = {
  customer: "Customer cancelled",
  noaccess: "No access on the day",
  us: "We cancelled"
};

// Less than 24 hours before the start (or already started) counts as late.
function isLateCancellation(start, now) {
  return start.getTime() - now.getTime() < 24 * 60 * 60 * 1000;
}

// Deletes every calendar event carrying this booking reference. Returns
// the start time of the (first) one found, or null.
function deleteBookingEvents(reference, hintStart) {
  var now = new Date();
  var found = null;
  var from = now.getTime() - 60 * 86400000;
  if (hintStart && hintStart.getTime() - 86400000 < from) from = hintStart.getTime() - 86400000;
  CalendarApp.getDefaultCalendar()
    .getEvents(new Date(from), new Date(now.getTime() + 400 * 86400000))
    .forEach(function (ev) {
      if (referenceFromEvent(ev) !== reference) return;
      if (!found) found = ev.getStartTime();
      ev.deleteEvent();
    });
  return found;
}

// opts: { reason: "customer" | "noaccess" | "us", note, emailCustomer, chargeFee }
function adminCancelJob(token, opts) {
  requireOwner();
  opts = opts || {};
  if (!CANCEL_REASONS[opts.reason]) return { ok: false, error: "Pick a reason first." };
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return { ok: false, error: "busy" };
  }
  try {
    return cancelJobLocked_(token, opts);
  } finally {
    lock.releaseLock();
  }
}

// opts.row: the booking row already looked up (online cancellations find it
// by the manage token). opts.cancelledBy: overrides the "Cancelled by" text.
function cancelJobLocked_(token, opts) {
  var row = opts.row || findBookingByToken(token);
  if (!row) return { ok: false, error: "not_found" };
  var v = row.values;
  if (v["Cancelled at"]) return { ok: true, alreadyCancelled: true };
  if (v["Completed at"]) return { ok: false, error: "This job is already signed off, so it can't be cancelled." };

  var now = new Date();
  var start = deleteBookingEvents(v.Reference, sheetStart_(v)) || sheetStart_(v);
  var late = !!start && isLateCancellation(start, now);
  // The fee is only ever for a late cancellation or no access, and never
  // when we're the ones cancelling (terms section 10).
  var chargeFee = !!opts.chargeFee && opts.reason !== "us" && (late || opts.reason === "noaccess");
  var whenStr = start ? fmtWhen(start) : bookingTimeText(v);

  try {
    refreshSlotsCache();
  } catch (cacheErr) {
    noteProblem_("Refreshing available times after a cancellation failed", cacheErr);
  }

  var sheet = getCustomerSheet();
  var header = ensureColumns(sheet, CANCELLATION_COLUMNS.concat(COMPLETION_COLUMNS));
  var writes = {
    "Cancelled at": now,
    "Cancelled by": (opts.cancelledBy || CANCEL_REASONS[opts.reason]) + (late ? " (less than 24 hours' notice)" : ""),
    "Cancellation note": String(opts.note || "").slice(0, 500)
  };

  var fee = null;
  if (chargeFee) {
    fee = buildCancellationFeeInvoice(v, opts.reason, whenStr, now);
    writes["Cancellation fee"] = fee.amount;
    writes["Invoice number"] = fee.invoiceNumber;
    writes["Invoice PDF"] = fee.url;
    writes["Payment due"] = fee.inv.dueDate;
    writes["Paid on"] = "";
  }
  Object.keys(writes).forEach(function (h) {
    sheet.getRange(row.rowIndex, header.indexOf(h) + 1).setValue(writes[h]);
  });
  // Income (FRE-187): a cancelled booking adds its fee, or nothing, never its total.
  try {
    writeIncome_(sheet, row.rowIndex, fee ? (parseMoney_(fee.amount) || 0) : 0);
  } catch (err) {
    noteProblem_("Recording the income failed for " + v.Reference, err);
  }

  var emailed = false;
  if (opts.emailCustomer && v.Email) {
    try {
      sendCancellationEmail(v, opts.reason, whenStr, fee);
      emailed = true;
    } catch (err) {
      noteProblem_("Cancellation email failed for " + v.Reference, err);
      notifyOwner("Cancellation email failed for " + v.Reference,
        "The booking is cancelled" + (fee ? " and the fee invoice " + fee.inv.invoiceNo + " is in your Unpaid list" : "") +
        ", but the email to the customer didn't send (" + err + "). Let them know directly.");
    }
  }
  return {
    ok: true,
    calendarRemoved: !!start,
    emailed: emailed,
    invoiceNo: fee ? fee.inv.invoiceNo : "",
    feeAmount: fee ? fee.amount : ""
  };
}

// Builds, numbers and saves the £25 fee invoice. The PDF reuses the normal
// invoice layout with a single fee line; the booking itself is untouched.
function buildCancellationFeeInvoice(v, reason, whenStr, now) {
  var amount = "£" + LATE_CANCELLATION_FEE;
  var invoiceNumber = nextInvoiceNumber(true); // already holding the script lock
  var inv = buildInvoiceContext(v, invoiceNumber, now);
  inv.paymentDue = true;
  inv.dueOnCompletion = false;
  inv.dueDate = new Date(now.getTime() + CANCELLATION_FEE_TERMS_DAYS * 24 * 60 * 60 * 1000);
  inv.bank = getBankDetails();
  inv.workAtLabel = "Booking at";
  var label = reason === "noaccess" ? "Call-out fee (no access)" : "Late cancellation fee";
  var feeRow = {};
  Object.keys(v).forEach(function (k) { feeRow[k] = v[k]; });
  // One invoice line. No ", " in it: the invoice splits item lines on that.
  var whenPart = whenStr ? " on " + String(whenStr).replace(/, /g, " at ") : "";
  feeRow.Items = label + " for booking " + v.Reference + whenPart + ": " + amount;
  feeRow.Total = amount;
  var blob = null, url = "";
  try {
    blob = buildInvoicePdfBlob(feeRow, inv);
  } catch (err) {
    noteProblem_("Cancellation fee invoice PDF failed for " + v.Reference, err);
    notifyOwner("Fee invoice PDF failed for " + v.Reference, "The booking is cancelled and " + inv.invoiceNo + " is recorded in your Unpaid list, but its PDF couldn't be created (" + err + "). Send the customer the fee details by hand.");
  }
  if (blob) {
    try {
      url = saveDocumentToDrive(INVOICES_FOLDER_NAME, now, blob);
    } catch (err) {
      url = "Not saved to Drive (see execution log)";
      noteProblem_("Saving the cancellation fee invoice to Drive failed for " + v.Reference, err);
    }
  }
  return { amount: amount, invoiceNumber: invoiceNumber, inv: inv, blob: blob, url: url };
}

function sendCancellationEmail(v, reason, whenStr, fee, at) {
  var isAgent = v.Channel === "Agent/Landlord";
  var name = isAgent ? (v.Name || v["Business name"]) : v.Name;
  var what = "your booking" + (whenStr ? " for " + whenStr : "") + " at " + v.Address + " (ref " + v.Reference + ")";
  var heading, body;
  if (reason === "us") {
    heading = "We've had to cancel your booking";
    body = "Sorry, we've had to cancel " + what + ". There's nothing to pay. We'll be in touch to find a new time, or you can rebook online at easycleansomerset.co.uk whenever suits.";
  } else if (reason === "online") {
    // The written acknowledgement the regulations ask for when someone
    // cancels through our website (FRE-213). Online cancellations never
    // carry a fee.
    heading = "Your booking is cancelled";
    body = "We've received your cancellation, made online on " + fmtWhen(at || new Date()) + ". " +
      "Your booking" + (whenStr ? " for " + whenStr : "") + " at " + v.Address + " (ref " + v.Reference + ") is cancelled, and there's nothing to pay.";
  } else if (reason === "noaccess") {
    heading = "We couldn't get in today";
    body = "We weren't able to get into the property for " + what + ", so the booking has been cancelled.";
  } else {
    heading = "Your booking is cancelled";
    body = "As requested, " + what + " has been cancelled.";
  }
  if (fee) {
    var dueStr = Utilities.formatDate(fee.inv.dueDate, TIMEZONE, "d MMMM yyyy");
    body += " " + (reason === "noaccess"
      ? "As set out in our terms (section 5), a " + fee.amount + " call-out fee applies when we can't get access."
      : "As it was cancelled with less than 24 hours' notice, a " + fee.amount + " late cancellation fee applies, as set out in our terms (section 5).") +
      " Invoice " + fee.inv.invoiceNo + " is attached, payment due by " + dueStr + ". Please use " + fee.inv.invoiceNo + " as the payment reference.";
  }
  if (reason !== "us") body += " If you'd like to rebook, you can book online at easycleansomerset.co.uk or just reply to this email.";

  var opts = {
    htmlBody: buildSimpleEmailHtml({ name: name, heading: heading, body: body }),
    name: "EasyClean Somerset"
  };
  if (fee && fee.blob) opts.attachments = [fee.blob];
  if (isAgent && fee && fee.inv.accountsEmail && fee.inv.accountsEmail.toLowerCase() !== String(v.Email).toLowerCase()) {
    opts.cc = fee.inv.accountsEmail;
  }
  var subject = "Booking cancelled: " + v.Reference + (fee ? " (Invoice " + fee.inv.invoiceNo + ")" : "");
  sendCustomerEmail_(v.Email, subject, "Hi " + name + ",\n\n" + body + "\n\nThanks,\nEasyClean Somerset", opts);
}

function sendPaymentReceipt(v, paidOn) {
  var isAgent = v.Channel === "Agent/Landlord";
  var invoiceNo = formatInvoiceNo(v["Invoice number"]);
  var name = isAgent ? (v.Name || v["Business name"]) : v.Name;
  var dateStr = Utilities.formatDate(paidOn, TIMEZONE, "d MMMM yyyy");
  var line = "We've received your payment of " + (v["Cancellation fee"] || v.Total) + " for invoice " + invoiceNo +
    " (" + v.Address + ", our ref " + v.Reference + "), paid " + dateStr + ". Nothing further to pay.";
  var opts = {
    htmlBody: buildSimpleEmailHtml({ name: name, heading: "Payment received, thank you", body: line }),
    name: "EasyClean Somerset"
  };
  if (isAgent) {
    try {
      var agency = getAgencyBilling(v["Business name"]);
      if (agency.accountsEmail && agency.accountsEmail.toLowerCase() !== String(v.Email).toLowerCase()) opts.cc = agency.accountsEmail;
    } catch (err) { /* receipt still goes to the booker */ }
  }
  sendCustomerEmail_(v.Email, "Payment received: " + invoiceNo, "Hi " + name + ",\n\n" + line + "\n\nThanks,\nEasyClean Somerset", opts);
}

// Same branded shell as the other customer emails, for short one-message
// emails (currently just the payment receipt).
function buildSimpleEmailHtml(d) {
  var esc = escHtml;
  var INK = "#12232B", TEAL = "#0E7C86", PAPER = "#F5F7F6", SURFACE = "#FFFFFF";
  var LINE = "#DCE3E2", SLATE = "#5C6F73", ON_INK = "#F5F7F6", STAMP = "#B5461E";
  var SANS = "Arial,Helvetica,sans-serif";
  var LOGO_URL = SITE_URL + "/apple-touch-icon.png";
  return (
    '<div style="background:' + PAPER + ';padding:40px 16px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
        '<tr><td style="background:' + INK + ';padding:26px 28px;text-align:center;">' +
          '<img src="' + LOGO_URL + '" width="36" height="36" alt="EasyClean Somerset" style="display:inline-block;vertical-align:middle;width:36px;height:36px;" />' +
          '<span style="display:inline-block;vertical-align:middle;margin-left:12px;font-family:' + SANS + ';font-weight:800;font-size:18px;text-transform:uppercase;color:' + ON_INK + ';">Easy<span style="color:' + TEAL + ';">Clean</span> Somerset</span>' +
        '</td></tr>' +
        '<tr><td style="background:' + SURFACE + ';border-left:1px solid ' + LINE + ';border-right:1px solid ' + LINE + ';padding:30px 28px;">' +
          '<p style="margin:0 0 6px;font-family:' + SANS + ';font-size:14px;color:' + SLATE + ';">Hi ' + esc(d.name) + ',</p>' +
          '<h1 style="margin:0 0 6px;font-family:' + SANS + ';font-weight:800;font-size:24px;color:' + INK + ';">' + esc(d.heading) + '</h1>' +
          '<div style="width:36px;height:3px;background:' + STAMP + ';margin:0 0 18px;font-size:3px;line-height:3px;">&nbsp;</div>' +
          (d.paragraphs
            ? d.paragraphs.map(function (p, i) {
                return '<p style="margin:0 0 ' + (i === d.paragraphs.length - 1 ? '0' : '14px') + ';font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + SLATE + ';">' + esc(p.text) +
                  (p.link ? ' <a href="' + esc(p.link.url) + '" style="color:' + TEAL + ';font-weight:700;">' + esc(p.link.label) + '</a>.' : '') + '</p>';
              }).join("")
            : '<p style="margin:0;font-family:' + SANS + ';font-size:14.5px;line-height:1.65;color:' + SLATE + ';">' + esc(d.body) + '</p>') +
          (d.button
            ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 0;"><tr><td style="background:' + TEAL + ';border-radius:3px;">' +
                '<a href="' + esc(d.button.url) + '" style="display:inline-block;padding:12px 24px;font-family:' + SANS + ';font-weight:700;font-size:14.5px;color:' + ON_INK + ';text-decoration:none;">' + esc(d.button.text) + '</a>' +
              '</td></tr></table>'
            : '') +
        '</td></tr>' +
        '<tr><td style="background:' + PAPER + ';border:1px solid ' + LINE + ';border-top:none;padding:20px 28px;text-align:center;font-family:' + SANS + ';font-weight:800;font-size:12.5px;text-transform:uppercase;color:' + SLATE + ';">EasyClean Somerset</td></tr>' +
        '<tr><td style="background:' + TEAL + ';height:5px;font-size:5px;line-height:5px;">&nbsp;</td></tr>' +
      '</table>' +
      traderHtml_() +
    '</div>'
  );
}


// ---- Agent access arrangements ----
// Agents either name someone who'll be on site, or choose to arrange access
// with us themselves (keys, lockbox, tenant) at least 24 hours before.
function accessLabel(data) {
  return data.accessArrange ? "Agent arranging (24h notice)" : "Someone on site";
}

function accessEmailText(data) {
  return data.accessArrange
    ? "To arrange. Please get in touch at least 24 hours before the clean to let us know how we'll get in (keys, lockbox code or the tenant's details). Reply to this email or WhatsApp us."
    : data.siteContactName + " (" + data.siteContactPhone + ") will let us in.";
}

// ============================================================
// Booking safeguards: slot check, server-side pricing, rate cap,
// and alerts to Niall
// ============================================================

// More booking attempts than this within an hour pauses online booking
// (customers get the WhatsApp fallback) and emails Niall. A real busy hour
// for a one-van business is well under this.
var MAX_BOOKINGS_PER_HOUR = 8;   // real bookings an hour before online booking pauses
var MAX_ATTEMPTS_PER_HOUR = 40;  // all attempts (including refused ones) an hour

// Two limits per clock hour: real bookings made (MAX_BOOKINGS_PER_HOUR) and
// all attempts that got past the basic checks (MAX_ATTEMPTS_PER_HOUR, a
// much higher number). Junk requests that are refused can no longer switch
// online booking off on their own. Returns false (fine), true (over the
// limit, alert Niall) or "quiet" (over the limit, already alerted this hour).
function bookingRateExceeded() {
  var cache = CacheService.getScriptCache();
  var hour = Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMddHH");
  var attemptsKey = "bookingAttempts_" + hour;
  var attempts = parseInt(cache.get(attemptsKey) || "0", 10) + 1;
  cache.put(attemptsKey, String(attempts), 3700);
  var made = parseInt(cache.get("bookingsMade_" + hour) || "0", 10);
  if (made < MAX_BOOKINGS_PER_HOUR && attempts <= MAX_ATTEMPTS_PER_HOUR) return false;
  // Only email once per hour, not on every turned-away attempt.
  if (cache.get(attemptsKey + "_alerted")) return "quiet";
  cache.put(attemptsKey + "_alerted", "1", 3700);
  return true;
}

function countBooking() {
  var cache = CacheService.getScriptCache();
  var key = "bookingsMade_" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMddHH");
  cache.put(key, String(parseInt(cache.get(key) || "0", 10) + 1), 3700);
}

// Is this a start time we'd actually offer? Same rules as getAvailableSlots()
// (a listed weekday start time, at least LEAD_TIME_HOURS ahead, within
// DAYS_AHEAD), with an hour's grace on the lead time so someone who loaded
// the page a while ago and books a slot that's just crossed the 24-hour
// line isn't turned away. Clashes are checked separately against the
// calendar.
function isOfferableSlot(start) {
  if (!(start instanceof Date) || isNaN(start.getTime())) return false;
  var now = Date.now();
  if (start.getTime() < now + (LEAD_TIME_HOURS - 1) * 3600000) return false;
  if (start.getTime() > now + (DAYS_AHEAD + 1) * 86400000) return false;
  if (isClosedDay(start)) return false;
  var hhmm = Utilities.formatDate(start, TIMEZONE, "HH:mm");
  var weekday = parseInt(Utilities.formatDate(start, TIMEZONE, "u"), 10) % 7; // 1=Mon..7=Sun -> Sun=0
  return (WEEKLY_SLOTS[weekday] || []).indexOf(hhmm) !== -1;
}

// ---- Bank holidays and other closed days ----
// England and Wales bank holidays come from GOV.UK's official list
// (www.gov.uk/bank-holidays.json), read once a day at most and remembered.
// If GOV.UK can't be reached, the last list read is used, and failing that
// the built-in list below (checked against GOV.UK on 3 Oct 2026). Christmas
// Day, Boxing Day and New Year's Day are always closed, whatever the
// weekday. Anything else (holidays, days off) is blocked from the admin
// app's "Time off" tab, or by any event in your calendar.
var BANK_HOLIDAYS_URL = "https://www.gov.uk/bank-holidays.json";
var BANK_HOLIDAYS_BUILT_IN = [
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28"
];
var ALWAYS_CLOSED_DAYS = ["12-25", "12-26", "01-01"]; // MM-dd

function getBankHolidays() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get("bankHolidays_v1");
  if (hit) return JSON.parse(hit);
  var props = PropertiesService.getScriptProperties();
  var dates = null;
  try {
    var res = UrlFetchApp.fetch(BANK_HOLIDAYS_URL, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() === 200) {
      var ew = JSON.parse(res.getContentText())["england-and-wales"];
      dates = (ew && ew.events || []).map(function (e) { return e.date; }).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });
      if (dates.length) props.setProperty("BANK_HOLIDAYS_LAST_GOOD", JSON.stringify(dates));
      else dates = null;
    }
  } catch (err) {
    console.error("Bank holiday list unavailable: " + err);
  }
  if (!dates) {
    try { dates = JSON.parse(props.getProperty("BANK_HOLIDAYS_LAST_GOOD") || "null"); } catch (e) { dates = null; }
  }
  var all = BANK_HOLIDAYS_BUILT_IN.concat(dates || []).filter(function (d, i, a) { return a.indexOf(d) === i; });
  cache.put("bankHolidays_v1", JSON.stringify(all), 21600);
  return all;
}

// Set of closed days, keyed both "yyyy-MM-dd" (bank holidays) and "MM-dd"
// (the always-closed days), for quick lookups while building slots.
function closedDaySet() {
  var set = {};
  getBankHolidays().forEach(function (d) { set[d] = true; });
  ALWAYS_CLOSED_DAYS.forEach(function (d) { set[d] = true; });
  return set;
}

function isClosedDay(date) {
  var set = closedDaySet();
  return !!(set[Utilities.formatDate(date, TIMEZONE, "yyyy-MM-dd")] || set[Utilities.formatDate(date, TIMEZONE, "MM-dd")]);
}

// ---- Server-side pricing ----
// The price list customers see lives in the website pages themselves
// (index.html for homeowners, agents.html for agents). Rather than keep a
// second copy here that could drift, the backend reads the live page's
// price rows (cached for an hour) and prices every booking from them. So a
// price change is still made in one place on the website, and the backend
// picks it up on its own.

var FIXED_OVERHEAD_MINS = 45; // must match FIXED_OVERHEAD_MINS in the website's JS
var PRICE_CACHE_SECONDS = 3600;

function priceListPage(channel) {
  return channel === "Agent/Landlord" ? "agents.html" : "index.html";
}

function getPriceList(channel, skipCache) {
  var page = priceListPage(channel);
  var key = "priceList_v1_" + page;
  var cache = CacheService.getScriptCache();
  if (!skipCache) {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  }
  var res = UrlFetchApp.fetch(SITE_URL + "/" + page, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error("Price page returned " + res.getResponseCode());
  var list = parsePriceRows(res.getContentText());
  if (!Object.keys(list).length) throw new Error("No price rows found on " + page);
  cache.put(key, JSON.stringify(list), PRICE_CACHE_SECONDS);
  return list;
}

// Reads every <div class="item-row" data-item=".." data-price=".." data-mins="..">.
function parsePriceRows(html) {
  var list = {};
  var re = /<div class="item-row"([^>]*)>/g, m;
  while ((m = re.exec(html))) {
    var attrs = m[1];
    var name = (attrs.match(/data-item="([^"]*)"/) || [])[1];
    var price = parseInt((attrs.match(/data-price="(\d+)"/) || [])[1], 10);
    var mins = parseInt((attrs.match(/data-mins="(\d+)"/) || [])[1], 10);
    if (name && !isNaN(price) && !isNaN(mins)) list[decodeHtmlAttr(name)] = { price: price, mins: mins };
  }
  return list;
}

function decodeHtmlAttr(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// What the customer asked for, as [{item, qty}]. Prefers the structured
// list newer pages send; falls back to reading the "2× Medium room: £90"
// text older cached pages send. Prices in that text are ignored.
function requestedLines(data) {
  if (Array.isArray(data.lineItems) && data.lineItems.length) {
    return data.lineItems.map(function (l) { return { item: String(l.item || ""), qty: parseInt(l.qty, 10) }; });
  }
  return String(data.items || "").split(", ").filter(String).map(function (line) {
    var m = line.match(/^(\d+)\s*[×x]\s*(.+?)(?::\s*£[\d,]+)?$/);
    return m ? { item: m[2].trim(), qty: parseInt(m[1], 10) } : { item: line, qty: NaN };
  });
}

function formatGBPServer(n) {
  return "£" + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatMinsServer(mins) {
  var h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return m + " min";
  if (m === 0) return h + "h";
  return h + "h " + m + "m";
}

// Returns { ok, items, total, estTime, verified, adjusted, pageTotal } or
// { ok:false, error }. "verified:false" means the price list couldn't be
// read at all, so the browser's figures were used and Niall is told.
function priceBooking(data) {
  var lines = requestedLines(data);
  if (!lines.length) return { ok: false, error: "missing_fields" };
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].item || !(lines[i].qty >= 1 && lines[i].qty <= 20)) return { ok: false, error: "bad_items" };
  }
  var list;
  try {
    list = getPriceList(data.channel);
    // An item we don't recognise may just mean the price list changed in
    // the last hour: re-read it fresh once before refusing.
    if (lines.some(function (l) { return !list[l.item]; })) list = getPriceList(data.channel, true);
  } catch (err) {
    noteProblem_("Couldn't read the price list, so a booking used the page's prices", err);
    return { ok: true, verified: false, items: data.items, total: data.total, estTime: data.estTime, pageTotal: data.total };
  }
  var total = 0, mins = 0, text = [];
  for (var j = 0; j < lines.length; j++) {
    var p = list[lines[j].item];
    if (!p) return { ok: false, error: "unknown_item" };
    var lineTotal = p.price * lines[j].qty;
    total += lineTotal;
    mins += p.mins * lines[j].qty;
    text.push(lines[j].qty + "× " + lines[j].item + ": " + formatGBPServer(lineTotal));
  }
  mins += FIXED_OVERHEAD_MINS;
  var totalStr = formatGBPServer(total);
  return {
    ok: true, verified: true,
    items: text.join(", "),
    total: totalStr,
    estTime: "~" + formatMinsServer(mins),
    pageTotal: data.total,
    adjusted: String(data.total || "") !== totalStr
  };
}

/**
 * Run once after pasting this version (function dropdown -> Run). It asks
 * Google for the new "connect to an external service" permission the price
 * check needs, and logs the price lists it reads from the live site. Until
 * this permission is granted, bookings fall back to the browser's prices
 * and you get an email saying so.
 */
function checkPriceList() {
  ["Consumer", "Agent/Landlord"].forEach(function (channel) {
    var list = getPriceList(channel, true);
    Logger.log(priceListPage(channel) + ": " + Object.keys(list).length + " items");
    Object.keys(list).forEach(function (k) { Logger.log("  " + k + ": £" + list[k].price + ", " + list[k].mins + " min"); });
  });
  Logger.log("Service area: " + getServiceArea(true).join(", "));
}

// ---- Service area ----
// The list of postcode districts lives in service-area.js on the website,
// so the page and this check always agree and there's one place to edit.
// Read with UrlFetchApp and cached for an hour. If the file can't be read,
// the booking goes through and Niall's new-booking email says the area
// wasn't checked (same approach as the price list).

var AREA_CACHE_SECONDS = 3600;

function getServiceArea(skipCache) {
  var key = "serviceArea_v1";
  var cache = CacheService.getScriptCache();
  if (!skipCache) {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  }
  var res = UrlFetchApp.fetch(SITE_URL + "/service-area.js", { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error("service-area.js returned " + res.getResponseCode());
  var list = parseServiceArea(res.getContentText());
  if (!list.length) throw new Error("No postcode districts found in service-area.js");
  cache.put(key, JSON.stringify(list), AREA_CACHE_SECONDS);
  return list;
}

// Reads the quoted districts inside window.EC_SERVICE_AREA = [ ... ];
function parseServiceArea(js) {
  var m = String(js).match(/EC_SERVICE_AREA\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  var body = m[1].replace(/\/\/[^\n]*/g, "");
  var out = [], re = /["']([A-Za-z]{1,2}[0-9][A-Za-z0-9]?)["']/g, d;
  while ((d = re.exec(body))) out.push(d[1].toUpperCase());
  return out;
}

// The district (first half) of a full UK postcode, or null.
function postcodeOutward(raw) {
  var s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  var m = s.match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/);
  return m ? m[1] : null;
}

function checkServiceArea(data) {
  var outward = postcodeOutward(data.postcode);
  if (!outward) return { ok: false, error: "bad_postcode" };
  var list;
  try {
    list = getServiceArea(false);
  } catch (err) {
    noteProblem_("Couldn't read service-area.js, so a postcode wasn't checked", err);
    return { ok: true, verified: false };
  }
  if (list.indexOf(outward) === -1) return { ok: false, error: "out_of_area", outward: outward };
  return { ok: true, verified: true };
}

// ---- Alerts to Niall ----

function ownerEmail() {
  return Session.getEffectiveUser().getEmail();
}

// Never throws: an alert failing must not break whatever triggered it.
// Returns true if the email went.
function notifyOwner(subject, body) {
  try {
    var to = ownerEmail();
    if (!to) return false;
    GmailApp.sendEmail(to, "[EasyClean] " + subject, body + "\n\n(Automatic message from your booking system.)", { name: "EasyClean booking system" });
    return true;
  } catch (err) {
    noteProblem_("An email to you failed to send", err);
    return false;
  }
}

// ---- Health check and problem log (FRE-185) ----
// Most failures here are caught so one problem never stops the rest, which
// also means Google's own failure emails never fire. So anything that goes
// wrong is noted in a small log (Script Properties), and each morning the
// daily trigger checks the system and emails you if anything needs a look.
// Once a week (Mondays) it sends a short "all fine" email even when nothing
// is wrong, so if that stops arriving you know the checks have stopped.
var PROBLEM_LOG_KEY = "PROBLEM_LOG";
var PROBLEM_LOG_MAX = 25;
var HEALTH_STATE_KEY = "HEALTH_LAST_ALERT";

// Logs a problem and keeps it for the morning check. Never throws.
function noteProblem_(where, err) {
  var msg = String(err && err.message ? err.message : (err === undefined ? "" : err)).replace(/\s+/g, " ").slice(0, 160);
  console.error(where + ": " + msg);
  try {
    var props = PropertiesService.getScriptProperties();
    var log = readProblemLog_();
    log.push({ t: new Date().toISOString(), where: String(where).slice(0, 90), msg: msg });
    if (log.length > PROBLEM_LOG_MAX) log = log.slice(-PROBLEM_LOG_MAX);
    var json = JSON.stringify(log);
    while (json.length > 8000 && log.length > 1) { log.shift(); json = JSON.stringify(log); } // property size limit
    props.setProperty(PROBLEM_LOG_KEY, json);
  } catch (e) {
    console.error("Couldn't record a problem: " + e);
  }
}

function readProblemLog_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(PROBLEM_LOG_KEY) || "[]") || []; }
  catch (e) { return []; }
}

// What a customer turned away online saw go wrong, in plain words. Taken
// slots (two people at once) and "busy" (which has its own alert) don't
// count as problems.
var REFUSAL_REASONS = {
  missing_fields: "Something the form needs was missing.",
  bad_details: "The email, phone, name or address didn't pass the checks (for example two email addresses, or no number in the phone box).",
  bad_postcode: "The postcode wasn't a full UK postcode.",
  out_of_area: "The postcode is outside the area in service-area.js.",
  unknown_item: "An item in the basket isn't on the live price list. Usually a price name changed while someone had the old page open, or the page and the price list disagree.",
  bad_items: "The basket was empty, too big, or had an odd quantity.",
  server_error: "The booking system hit an error. Details are in Apps Script under Executions."
};
var REFUSALS_NOT_ALERTED = ["slot_taken", "busy"];

// A website booking was turned away: note it, and email you straight away
// (at most once an hour; any more are in the next morning's check).
function noteRefusedBooking_(data, code) {
  if (REFUSALS_NOT_ALERTED.indexOf(code) !== -1) return;
  var reason = REFUSAL_REASONS[code] || "Error code: " + code;
  if (code !== "server_error") noteProblem_("Online booking turned away (" + code + ")", reason); // server errors are already noted
  try {
    var cache = CacheService.getScriptCache();
    var key = "refusedAlert_" + Utilities.formatDate(new Date(), TIMEZONE, "yyyyMMddHH");
    if (cache.get(key)) return;
    cache.put(key, "1", 3700);
    var d = data || {};
    var str = function (x) { return String(x === undefined || x === null ? "" : x).slice(0, 200); };
    var items = Array.isArray(d.lineItems) && d.lineItems.length
      ? d.lineItems.map(function (l) { return str(l && l.qty) + "x " + str(l && l.item); }).join(", ")
      : str(d.items);
    notifyOwner("Online booking turned away (" + code + ")", [
      "Someone tried to book on the website and it didn't go through.",
      "",
      "Why: " + reason,
      "",
      "What they entered:",
      "Name: " + str(d.name) + (d.businessName ? " (" + str(d.businessName) + ")" : ""),
      "Phone: " + str(d.phone),
      "Email: " + str(d.email),
      "Address: " + str(d.address) + (d.postcode ? ", " + str(d.postcode) : ""),
      "Items: " + items,
      "Time picked: " + str(d.slotLabel || d.startTime),
      "",
      "The page offered them WhatsApp instead, so they may message you. If the details look like nonsense, it was probably a bot and you can ignore this.",
      "You'll get at most one of these an hour. Any others are listed in the next morning's check."
    ].join("\n"));
  } catch (err) {
    console.error("Turned-away booking alert failed: " + err);
  }
}

// The morning check. Emails you only when something needs a look, plus a
// short "all fine" note on Mondays. The same unchanged problem isn't
// repeated more than every 3 days. Pass { force: true } to always email.
function dailyHealthCheck_(opts) {
  opts = opts || {};
  var now = opts.now || new Date();
  var issues = [];
  var check = function (label, fn) {
    try { var msg = fn(); if (msg) issues.push(msg); }
    catch (err) { issues.push(label + " (" + String(err && err.message || err).slice(0, 160) + ")"); }
  };
  check("Couldn't work out the available booking times", function () {
    var slots = refreshSlotsCache();
    return slots.length ? "" : "No online booking times in the next " + DAYS_AHEAD + " days. Fine if you've blocked that time off; otherwise check your calendar.";
  });
  ["Consumer", "Agent/Landlord"].forEach(function (ch) {
    check("Couldn't read the prices on " + priceListPage(ch) + ", so bookings are taken at the page's prices", function () {
      var n = Object.keys(getPriceList(ch, true)).length;
      return n >= 5 ? "" : "Only " + n + " prices found on " + priceListPage(ch) + ". Check the price rows on that page.";
    });
  });
  check("Couldn't read service-area.js, so postcodes aren't being checked", function () { getServiceArea(true); return ""; });
  check("Couldn't check the email allowance", function () {
    var left = MailApp.getRemainingDailyQuota();
    return left >= 20 ? "" : "Only " + left + " emails left in today's Gmail allowance. When it runs out, confirmations and these alerts stop until it resets.";
  });
  check("Couldn't check the scheduled jobs", function () {
    var names = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    return names.indexOf("refreshSlotsCache") !== -1 ? "" : "The 10-minute refresh of available times isn't scheduled. Run setUpAutoRefresh once.";
  });
  check("Couldn't open the customer sheet", function () { return getCustomerSheet() ? "" : "The customer sheet can't be found, so bookings aren't being recorded. Run setUpCustomerSheet."; });
  check("Couldn't check the settings", function () {
    var missing = [];
    if (!getAdminUrl()) missing.push("ADMIN_URL");
    if (!getBankDetails().complete) missing.push("the bank details");
    return missing.length ? "Missing from Script Properties: " + missing.join(" and ") + "." : "";
  });
  // Bookings that have gone missing from the calendar, and jobs done but not
  // signed off, so not invoiced (FRE-203).
  var open = null;
  var openNow = function () { if (!open) open = openBookingIssues_(now); return open; };
  check("Couldn't check the bookings against the calendar", function () {
    var list = openNow().missing;
    if (!list.length) return "";
    return (list.length === 1 ? "1 booking isn't" : list.length + " bookings aren't") + " in your calendar any more: " + list.join(", ") + ". " +
      "Its time can be booked by someone else and no reminders go out. Open it in the admin app to put it back in the calendar, or cancel it so there's a record.";
  });
  check("Couldn't check the jobs waiting for sign-off", function () {
    var list = openNow().unsigned;
    if (!list.length) return "";
    return (list.length === 1 ? "1 job" : list.length + " jobs") + " done more than " + SIGNOFF_NUDGE_DAYS + " days ago " +
      (list.length === 1 ? "isn't" : "aren't") + " signed off yet, so " + (list.length === 1 ? "it hasn't" : "they haven't") + " been invoiced: " + list.join(", ") + ". " +
      "They're under Waiting for sign-off in the admin app.";
  });
  check("Couldn't check the bank holiday list", function () {
    var latest = getBankHolidays().slice().sort().pop();
    if (!latest) return "";
    var p = latest.split("-");
    var daysLeft = Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - now.getTime()) / 86400000);
    return daysLeft >= 60 ? "" : "The bank holiday list only runs to " + latest + " and GOV.UK hasn't been read recently. Add the next year's dates to BANK_HOLIDAYS_BUILT_IN.";
  });

  var log = readProblemLog_();
  var grouped = {}, order = [];
  log.forEach(function (e) {
    var k = e.where + "|" + e.msg;
    if (!grouped[k]) { grouped[k] = { where: e.where, msg: e.msg, count: 0, last: e.t }; order.push(k); }
    grouped[k].count++; grouped[k].last = e.t;
  });
  var events = order.map(function (k) {
    var g = grouped[k];
    return (g.count > 1 ? g.count + "x " : "") + g.where + (g.msg ? ": " + g.msg : "") + " (last " + fmtWhen(new Date(g.last)) + ")";
  });

  var props = PropertiesService.getScriptProperties();
  var signature = issues.join("|");
  var state = {};
  try { state = JSON.parse(props.getProperty(HEALTH_STATE_KEY) || "{}") || {}; } catch (e) { state = {}; }
  var isMonday = Utilities.formatDate(now, TIMEZONE, "u") === "1";
  var repeat = state.signature === signature && state.sentAt && now.getTime() - new Date(state.sentAt).getTime() < 3 * 86400000;

  var subject, body;
  if (issues.length || events.length) {
    if (!opts.force && !events.length && repeat) return { sent: false, issues: issues, events: events };
    var n = issues.length + events.length;
    subject = "Booking system check: " + n + (n === 1 ? " thing" : " things") + " to look at";
    body = (issues.length ? "Needs a look now:\n" + issues.map(function (x) { return "- " + x; }).join("\n") + "\n\n" : "") +
      (events.length ? "Went wrong since the last check:\n" + events.map(function (x) { return "- " + x; }).join("\n") + "\n\n" : "") +
      "More detail is in Apps Script under Executions.";
  } else if (isMonday || opts.force) {
    subject = "Booking system check: all fine";
    body = "This morning's check found nothing wrong: booking times, prices, service area, email allowance, scheduled jobs, customer sheet, settings, bookings against the calendar and jobs waiting for sign-off.\n\n" +
      "You get this note once a week. If it stops arriving, the morning job has stopped: run setUpDailyReminders once to restart it.";
  } else {
    return { sent: false, issues: issues, events: events };
  }
  var sent = notifyOwner(subject, body);
  if (sent) {
    props.setProperty(PROBLEM_LOG_KEY, "[]");
    props.setProperty(HEALTH_STATE_KEY, JSON.stringify({ signature: signature, sentAt: now.toISOString() }));
  }
  return { sent: sent, issues: issues, events: events };
}

/**
 * Run this from the editor any time to check the booking system now
 * (pick "checkBookingSystem" in the function dropdown and press Run). It
 * always emails you the result, and the log shows it too.
 */
function checkBookingSystem() {
  requireOwner();
  var r = dailyHealthCheck_({ force: true });
  Logger.log(r.issues.length || r.events.length ? "Problems: " + r.issues.concat(r.events).join(" | ") : "All fine.");
  return { ok: true, sent: r.sent, problems: r.issues.length + r.events.length };
}

function sendNewBookingAlert(data, reference, jobToken, start, priced) {
  var when = Utilities.formatDate(start, TIMEZONE, "EEE d MMM 'at' h:mma").replace("AM", "am").replace("PM", "pm");
  var isAgent = data.channel === "Agent/Landlord";
  var who = isAgent && data.businessName !== data.name ? data.businessName + " (" + data.name + ")" : data.name;
  var lines = [
    who + " booked " + when + ".",
    "",
    "Reference: " + reference,
    "What: " + data.items,
    "Total: " + data.total + " (" + data.payment + ")",
    "Est. time: " + (data.estTime || "not specified"),
    "Where: " + data.address,
    "Phone: " + data.phone,
    "Email: " + data.email
  ];
  if (isAgent) lines.push("Access: " + accessEmailText(data));
  var agencyNote = isAgent ? agencyAlertText_(data.businessName, data.agencyCheck) : "";
  if (data.referralCode) lines.push("Referral/offer code: " + data.referralCode);
  if (data.agencyId) lines.push("Agent's reference: " + data.agencyId);
  if (data.notes) lines.push("Notes: " + data.notes);
  if (data.cancellation) lines.push("OK'd starting within 14 days: " + earlyStartRecord_(data.cancellation));
  if (data.cancellation && data.cancellation.within && !data.cancellation.earlyStart) {
    lines.push("", "NOTE: this clean is within their 14-day cancellation period, but they didn't tick the box asking us to start early (the page may have been open from before it was added). " +
      "As it stands they could cancel up to " + data.cancellation.deadline + " and pay nothing for work done. Worth asking them to confirm by message that they want it done early.");
  }
  if (priced && priced.adjusted) lines.push("", "NOTE: the page showed " + priced.pageTotal + " but the price list gives " + data.total + ". Booked at " + data.total + ".");
  if (agencyNote) lines.push("", "NOTE: " + agencyNote);
  if (data.areaUnchecked) lines.push("", "NOTE: the service area list couldn't be read, so the postcode wasn't checked. Worth a quick look at where this is.");
  if (priced && priced.verified === false) lines.push("", "NOTE: the price list couldn't be checked, so this was booked at the price the page sent. Worth a quick check.");
  var link = adminJobLink(jobToken, reference);
  lines.push("", "Open in admin: " + link);
  notifyOwner("New booking: " + who + ", " + when + ", " + data.total, lines.join("\n"));
}
