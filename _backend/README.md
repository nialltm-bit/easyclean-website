# Booking system: copy of the Apps Script files

This folder holds copies of the two files in the Google Apps Script project **EasyClean booking backend**, which is the booking system behind the website.

- **What the files are:**
  - `Code.gs` is the main script: slots, bookings, reminders, invoices and the admin app's server side.
  - `Dashboard.html` is the private admin app (the HTML file called "Dashboard" in Apps Script).
- **They're only copies.** GitHub doesn't run them. Because the folder name starts with `_`, the website never publishes them. The live versions are in Apps Script.

## Changing the booking system

1. Change the file here and commit it.
2. Paste the whole file into Apps Script (script.google.com, on the EasyClean Google account) and save.
3. Redeploy both deployments: Deploy > Manage deployments > edit each one > Version: New version > Deploy. One deployment is public ("Anyone") and one is the admin app ("Only myself"). Both run the same code, so both need the new version.
4. If the change notes say to run a function once, pick it in the function dropdown and press Run.

Keep the copy here and Apps Script the same. If either one changes, update the other.

## Never put these in the files

Bank details, `ADMIN_URL`, the customer sheet ID and the invoice counter live only in Apps Script under **Project Settings > Script Properties**.

## How the website and the booking system connect

Check these before changing either side.

- **Available times:** `booking.js` calls `GET ?action=slots` and gets back `{ ok, slots: [{ start, dayLabel, timeLabel }] }`.
  - The page shows whatever days come back.
  - `DAYS_AHEAD` in Code.gs sets the window (21 days).
  - `WEEKLY_SLOTS` sets the start times.
  - **Days with no times:** the booking system only sends free times, so `booking.js` draws every calendar day itself (Sundays and fully booked days show as dashed cards that say "No times"). To do that it copies two numbers from Code.gs: `LEAD_TIME_HOURS` (24) and `DAYS_AHEAD` (21). If you change either in Code.gs, change it in `booking.js` too. If they drift apart, no free time is ever hidden, only the empty days at the ends of the list are wrong.
- **Bookings:** `booking.js` sends `POST { action: "book", ... }` as JSON. Code.gs checks every field again and sends back `ok` or an error code that the page understands.
  - **Optional fields:** `parking` (the radio button's value, up to 60 characters) and `notes` (up to 400). Code.gs joins them into the job's Notes as "Parking: ... ." followed by the notes.
  - **Emails ask for the extras (FRE-209):** the booking form keeps parking, notes and the code under a closed "Anything else?" link, so many customers leave them empty. When `notes` is empty (it already holds the parking answer), the confirmation and day-before emails add a line asking them to reply with parking, pets, gate codes or stains. The morning-of reminder doesn't.
  - **Agent page:** the business name is optional. If it's blank, Code.gs uses the person's name, the same as the admin app does for a private landlord.
  - **Early start (home page only):** `earlyStart` is `true` when the customer ticked the box asking us to clean within their 14-day cancellation period. The page shows the box when the chosen time is within 14 days of today, and Code.gs works that out again with `CANCEL_DAYS`. Both use UK dates. A booking without the tick is never refused: Code.gs records "Not given" and flags it in the new-booking email.
- **Prices:**
  - **Where Code.gs reads them:** it doesn't trust the price the page sends. It reads the price rows on the built `index.html` and `agents.html` pages, in `parsePriceRows`.
  - **What it looks for:** each row must stay as `<div class="item-row" data-item="..." data-price="..." data-mins="...">`, with `class="item-row"` exactly. An extra class or a renamed attribute stops the price check finding the rows.
  - **Where prices change:** in `_data/prices.yml`.
- **Service area:** Code.gs reads `service-area.js` and expects the `window.EC_SERVICE_AREA = [ "BA1", ... ];` format.
- **Sign-off page:** `job-complete.html` uses `GET ?action=job&t=<token>` and `POST { action: "complete", ... }`.
- **Change or cancel page (FRE-211):** `my-booking.html?t=<manage token>` is linked from the Change or cancel button in the confirmation, day-before, morning-of and "booking moved" emails. The manage token is its own column (`Manage token`), separate from the job token, so it can't sign off a job.
  - `GET ?action=booking&t=` returns `{ ok, reference, channel: "homeowner"|"agent", date, time, whenLabel, addressShort, items: [{ name, qty }], total, estMins, canChange, notChangeableReason, movesLeft, cancelDeadline, earlyStartGiven }`. Nothing private: no email, phone, full address or notes.
  - `GET ?action=rescheduleSlots&t=` returns the same shape as `?action=slots`, for this job's length, with its own time not counted as busy.
  - `POST { action: "cancel", t, reason }` and `POST { action: "reschedule", t, date: "yyyy-MM-dd", time: "HH:mm", earlyStart }` return `{ ok }` or an error: `not_found`, `cancelled`, `completed`, `started`, `slot_taken`, `needs_early_start`, `no_moves_left`, `busy`, `server_error`.
  - **Rules:** changes until the clean starts; at most 2 online moves (`MAX_ONLINE_MOVES`); a new time follows the booking rules; a homeowner moving into their 14 days must tick the early-start box; online cancellations never carry a fee. `cancel` reasons are only kept if they're one of the page's four buttons.
- **WhatsApp number:** `WHATSAPP_NUMBER` in Code.gs must match the one in `booking.js`.

## Morning check

The daily trigger (`sendDayOfReminders`, around 7am) ends with a health check. It emails Niall if anything needs a look, including problems noted since the last check, and sends a short "all fine" note on Mondays. Turned-away website bookings also email him straight away (at most one an hour). To run the check by hand, pick `checkBookingSystem` in the function dropdown and press Run.

## Time on job, photos and figures

All of this is in `Code.gs` and `Dashboard.html`. The website doesn't read any of it.

- **Time on job (FRE-194):** the job page has Start and Finish buttons. They fill four columns in the Bookings sheet: `Est. mins` (the estimate the customer was shown; for older bookings it's read from the calendar event the first time), `Started at`, `Finished at` and `Actual mins`. If a job was started and never finished, sign-off finishes it, but only if that's within 8 hours of the start (`AUTO_FINISH_MAX_MINS`).
- **Photos (FRE-194):** Before and After buttons on the job page, on every job including signed-off and cancelled ones. The page shrinks each photo to 1800 pixels first. They're saved to a private Drive folder per job, inside "EasyClean Somerset — Job photos", named `EC-12345 Name`. The sheet's `Photos folder` column keeps the link, and the job page counts the files in the folder.
- **Photos in the agent PDF (FRE-194):** an agent job's completion PDF includes up to 4 Before and 4 After photos, unless the tick on the job page is turned off (`Photos in PDF` column says "No"). If the photos can't be read or make the PDF fail, the PDF is made without them and the problem is noted for the morning check. Homeowner PDFs never have photos.
- **Income column (FRE-187):** the `Income` column holds what each signed-off job or cancellation adds to the books: the job's total (nothing for "No charge"), or for a cancellation its fee, or nothing. Cancelled rows keep their original `Total`, so add up `Income`, not `Total`. It's filled in at sign-off and at cancellation.
- **Monthly figures (FRE-187):** the daily trigger emails Niall last month's figures on the first morning of each month (and on the next morning that runs if the 1st was missed). The first time it ever runs, mid-month, it only notes the month, so the first email is on the next 1st. Run `sendFiguresPreview` to get one now. The admin app's Figures tab shows the same numbers, plus this month so far.
- **How the figures count:** income is counted on the day a job is signed off, or a cancellation fee is invoiced, not the day it's paid. "Year to date" starts on 6 April (the tax year); change `FIGURES_YEAR` to `"calendar"` for 1 January. The VAT line is turnover over the last 12 months against `VAT_THRESHOLD` (£90,000). Unpaid uses the same rule as the Unpaid tab.

## Tests

- `node _tests/backend.test.js` runs `Code.gs` in Node with Google's services faked (`_tests/fake-google.js`). It needs no setup.
- `node _tests/change-or-cancel.test.js` checks the change-or-cancel calls, emails and rules (FRE-213). It needs no setup.
- `node _tests/cancellation-form.test.js` checks the homeowner confirmation email and its cancellation form PDF (FRE-212). It needs no setup.
- `node _tests/dashboard.test.js` drives `Dashboard.html` in a browser against the same fake, so the page and `Code.gs` are checked together. It needs the Playwright setup from `booking.test.js`.
- These fakes aren't Google. A change to anything that touches Drive, the calendar, Sheets or PDF layout still needs a real try after deploying.

## Last updated

8 October 2026 (later):

- Customers can change or cancel online (FRE-213, with the website page from FRE-214). New sheet columns: `Manage token` and `Online moves`. Every cancel or move emails the customer and Niall, and is written in `Changes` or `Cancelled by` ("Customer (online: reason)"). The confirmation, day-before and morning-of emails get a Change or cancel button next to WhatsApp. Run `setUpManageTokens` once so open bookings get the button in their reminders. `Code.gs` only.

8 October 2026:

- The model cancellation form now goes out as a PDF attached to homeowner confirmation emails (`cancellationFormPdf_`), pre-filled with the reference, booking date, name and address. The email keeps a short right-to-cancel section. If the PDF can't be made, the form goes in the email as before and the problem log notes it (FRE-212). Run `sendTestConfirmationEmail` to get a sample in your own inbox. `Code.gs` only.

7 October 2026:

- Time on job (Start and Finish on the job page) and Before and After photos, with the photos optionally in the agent completion PDF (FRE-194). New sheet columns: `Est. mins`, `Started at`, `Finished at`, `Actual mins`, `Photos folder`, `Photos in PDF`.
- Monthly figures email, Figures tab in the admin app, and an `Income` column that fixes cancelled bookings overstating income (FRE-187).
- Needs both `Code.gs` and `Dashboard.html` pasted into Apps Script, and both deployments redeployed.

6 October 2026:

- Morning health check and turned-away booking alerts (FRE-185).
- Aftercare plus a 2-day follow-up email (FRE-193).
- Trader details at the foot of every customer email: name and town, a link to the business details in the terms, and the email address (FRE-189). Customer emails go out through `sendCustomerEmail_`, which adds them to the plain-text version. The HTML builders add `traderHtml_()`.
- Booking form parking question and notes box, and an optional business name for private landlords (FRE-192). Notes now show in the new-booking email and the admin app's job view.
- Consumer Contracts Regulations (FRE-181): an "Early start request" column, a line in the new-booking email, and the right-to-cancel information with the model cancellation form in homeowner confirmation emails. Agent bookings are unchanged.

- Confirmation and day-before emails ask for parking, pets and gate codes by reply when the booking has no notes (FRE-209). The website form change in the same ticket needs no Apps Script change: the fields it sends are the same.

This matches Apps Script once that version is deployed.
