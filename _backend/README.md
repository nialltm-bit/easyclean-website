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
  - **One-time ID (`requestId`, FRE-203 and FRE-6):** the page can send a random `requestId` with each booking: 16 to 64 letters, numbers, `-` or `_`. It makes one per booking attempt and sends the same one again if it retries after a dropped connection. If Code.gs has already booked that `requestId`, it doesn't book again: it answers `{ ok: true, reference, repeat: true }` with the first booking's reference, even if that time now shows as taken. An ID of the wrong shape is ignored. Bookings without one still work. It's kept in the sheet's `Request ID` column (and cached for 6 hours).
  - **Early start (home page only):** `earlyStart` is `true` when the customer ticked the box asking us to clean within their 14-day cancellation period. The page shows the box when the chosen time is within 14 days of today, and Code.gs works that out again with `CANCEL_DAYS`. Both use UK dates. A booking without the tick is never refused: Code.gs records "No, ask the customer" and flags it in the new-booking email. The answer goes in the sheet column "Customer OK'd starting within 14 days" (it was "Early start request" until 9 October 2026).
- **Prices:**
  - **Where Code.gs reads them:** it doesn't trust the price the page sends. It reads the price rows on the built `index.html` and `agents.html` pages, in `parsePriceRows`.
  - **What it looks for:** each row must stay as `<div class="item-row" data-item="..." data-price="..." data-mins="...">`, with `class="item-row"` exactly. An extra class or a renamed attribute stops the price check finding the rows.
  - **Where prices change:** in `_data/prices.yml`.
- **Service area:** Code.gs reads `service-area.js` and expects the `window.EC_SERVICE_AREA = [ "BA1", ... ];` format.
- **Sign-off page:** `job-complete.html` uses `GET ?action=job&t=<token>` and `POST { action: "complete", ... }`.
- **Change or cancel page (FRE-211):** `my-booking.html?t=<manage token>` is linked from the Change or cancel button in the confirmation, day-before, "booking updated" (an admin app edit) and "booking moved" emails. The morning-of reminder and everything after the job (thank-you, follow-up, invoices, payment emails) don't have it; the morning-of reminder just says reply or WhatsApp. The manage token is its own column (`Manage token`), separate from the job token, so it can't sign off a job.
  - `GET ?action=booking&t=` returns `{ ok, reference, channel: "homeowner"|"agent", date, time, whenLabel, addressShort, items: [{ name, qty }], total, estMins, canChange, notChangeableReason, movesLeft, cancelDeadline, earlyStartGiven }`. Nothing private: no email, phone, full address or notes.
  - `GET ?action=rescheduleSlots&t=` returns the same shape as `?action=slots`, for this job's length, with its own time not counted as busy.
  - `POST { action: "cancel", t, reason }` and `POST { action: "reschedule", t, date: "yyyy-MM-dd", time: "HH:mm", earlyStart }` return `{ ok }` or an error: `not_found`, `cancelled`, `completed`, `started`, `slot_taken`, `needs_early_start`, `no_moves_left`, `busy`, `server_error`.
  - **Rules:** changes until the clean starts; at most 2 online moves (`MAX_ONLINE_MOVES`); a new time follows the booking rules; a homeowner moving into their 14 days must tick the early-start box; online cancellations never carry a fee. `cancel` reasons are only kept if they're one of the page's four buttons.
- **WhatsApp number:** `WHATSAPP_NUMBER` in Code.gs must match the one in `booking.js`.

## Morning check

The daily trigger (`sendDayOfReminders`, around 7am) ends with a health check. It emails Niall if anything needs a look, including problems noted since the last check, and sends a short "all fine" note on Mondays. It also lists any open booking that's missing from the calendar, and any job done more than 3 days ago (`SIGNOFF_NUDGE_DAYS`) that still isn't signed off, so isn't invoiced. Turned-away website bookings also email him straight away (at most one an hour). To run the check by hand, pick `checkBookingSystem` in the function dropdown and press Run.

## Booking times in the sheet (FRE-203)

- **Why:** the admin app used to get each job's time only from the calendar, looking 30 days either side of today. Jobs not signed off within 30 days dropped out of "Waiting for sign-off" and were never invoiced, and a booking whose event was deleted by hand vanished from every list.
- **What's kept:** `Starts at` and `Ends at` columns, written when a booking is made (website or admin app) and whenever it's moved (admin app edit or the customer's change page). When the admin app opens, it also copies the calendar's time into the sheet for open bookings that don't have one yet, or that were dragged to a new time in Google Calendar. The calendar still wins when both are there.
- **Dragged in Google Calendar:** the daily trigger (before the reminders) and the admin app both copy the calendar's time into the sheet. A move also rewrites the `Booking time` text, adds "moved in the calendar from ... to ..." to `Changes`, and, if it's a different day, clears the two "reminder sent" columns so the reminders go again for the new day (`syncOpenBookingTimes_`).
- **The lists:** "Waiting for sign-off" now has every past job that isn't signed off or cancelled, however old. "Coming up" is still the next 30 days.
- **Event deleted by hand:** the booking stays in the lists with a "Not in calendar" label. Its job page has a "Put it back in the calendar" button that makes the event again at the saved time (it asks first if something else is now in that slot). Until then its time is free on the website and no reminders go out, which is why the morning check lists it. Cancelling it still works and uses the saved time for the late-cancellation rule. If the customer moves it on their change page, the event is made again at the new time.
- **Older bookings with no saved time and no event:** these show under "Waiting for sign-off" with the label, with the `Booking time` text as their time. Cancel them so there's a record, or use Edit job to set a time.

## Customers (FRE-203, FRE-195)

- **Repeat customers:** a booking is matched to others with the same email (any case) or phone (any format: `07700...`, `+44 7700...`, `447700...`). Your new-booking email says "Booked before: N other bookings (done, still booked, cancelled). Latest: ...". In the admin app, job cards say "Booked before", and the job page lists up to 10 of their other bookings, newest first, each one tappable.
- **Site contact reminder:** the day before an agent job with a named site contact (not the booker's own number, not "agent arranging access"), the daily trigger emails you a list of tomorrow's agent jobs with a WhatsApp link for each one. The link opens a ready-written message to the tenant or site contact; you check it and press send. It's sent once per day (`SITE_CONTACT_DIGEST_DAY` in Script Properties). The open job's page in the admin app has the same "WhatsApp the site contact" button. No paid messaging service is involved.
- **Marketing opt-ins:**
  - Each opt-in saves the exact words of the tick box and the date, in `Marketing consent`. The words come from `MARKETING_CONSENT_TEXT` (one per page), or from `marketingConsentText` if the page ever sends it (up to 300 characters). Opt-ins from before 9 October 2026 have no words saved, and the list says so.
  - **If you change a tick box's wording on the website, change `MARKETING_CONSENT_TEXT` too.** The morning check reads both pages and tells you if they differ.
  - Unsubscribes: when someone replies STOP, open any of their jobs in the admin app and tap "They asked to stop: unsubscribe them". That sets `Unsubscribed on` for every booking with their email. Ticking the box on a later booking counts as fresh consent.
  - Before sending any marketing, run `refreshMarketingList` from the function dropdown. It rebuilds the "Marketing list" tab: one row per email that opted in and hasn't unsubscribed since, with the words they agreed to and when. Send only to that list, and every marketing email must say how to unsubscribe (for now, "reply STOP"). A one-click unsubscribe link would need a small page on the website; it isn't built yet.

## Invoices and the Agencies tab

- **Late payment (FRE-195):** agent invoices that are paid by bank transfer (including £25 fee invoices to agents) end with a line saying statutory interest at 8% above the Bank of England base rate may be charged, plus fixed compensation under the Late Payment of Commercial Debts (Interest) Act 1998: £40 under £1,000, £70 under £10,000, £100 above (`lateFeeCompensation_`). Homeowner invoices never have it (the Act is business to business). The base rate isn't written as a number, since it changes.
- **Agency names (FRE-195):** the Agencies tab has a `Same as` column.
  - Names that differ only in capitals, spaces, punctuation, "&" or "and", "The" or "Ltd" count as the same agency automatically (`agencyKey_`).
  - Other spellings are never merged on their own. When an agent books under a name that's new to the tab, it's added straight away, and the new-booking email says so. If the name looks like an existing one once words like "Lettings" or "Property" are set aside (`agencyCore_`), the email names it. Type the main agency's name in the new row's `Same as` column and its invoices and reminders use the main row's name, billing address and accounts email.
  - The email also flags a known agency that still has no billing address.
- **Job date (FRE-203):** when a job is signed off on a later day than the clean (a customer signing the link later), the invoice keeps the sign-off day as its invoice date and adds "Job date". A cash receipt says it was paid on the day of the clean, and `Paid on` is that day. The completion PDF says "Completed" with the clean's date and "Signed" with the sign-off date. The 2-day follow-up names the day of the clean; its re-clean deadline still runs from sign-off. The job date is the timer's start, else the calendar event, else `Starts at`, and never later than the sign-off. Agent invoices are still due 14 days from the invoice date. Income in the figures still counts on the sign-off day.

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
- `node _tests/booking-times.test.js` checks the saved booking times, the waiting list, putting a deleted event back, the morning check's new lines and one-time booking IDs (FRE-203, FRE-6). It needs no setup.
- `node _tests/invoices-agencies.test.js` checks the late-payment line, agency name matching and `Same as`, and the job date on jobs signed off later (FRE-195, FRE-203). It needs no setup.
- `node _tests/customers-and-contacts.test.js` checks jobs dragged in the calendar, repeat customers, the site contact email and link, and marketing consent, unsubscribes and the marketing list (FRE-203, FRE-195). It needs no setup.
- `node _tests/dashboard.test.js` drives `Dashboard.html` in a browser against the same fake, so the page and `Code.gs` are checked together. It needs the Playwright setup from `booking.test.js`.
- These fakes aren't Google. A change to anything that touches Drive, the calendar, Sheets or PDF layout still needs a real try after deploying.

## Last updated

9 October 2026 (later still):

- Jobs dragged in Google Calendar update the `Booking time` text and their reminders; repeat customers shown in the new-booking email and the admin app; a daily email with WhatsApp links for tomorrow's agent site contacts, plus a button on the job page; marketing consent wording saved with each opt-in, unsubscribes in the admin app, and `refreshMarketingList` (FRE-203, FRE-195). Needs `Code.gs` and `Dashboard.html` pasted into Apps Script, and both deployments redeployed. Nothing to run now: run `refreshMarketingList` only when you're about to send marketing.

9 October 2026 (afternoon):

- The Change or cancel button is now in the "booking updated" email too, and no longer in the morning-of reminder. `Code.gs` only.

9 October 2026 (later):

- Late-payment line on agent invoices, agency name matching with a `Same as` column in the Agencies tab, and the real job date on jobs signed off on a later day (FRE-195, FRE-203). `Code.gs` only. Nothing to run: the `Same as` column is added to the Agencies tab the next time it's read.

9 October 2026:

- The sheet column "Early start request" is now "Customer OK'd starting within 14 days", with plainer values: "Yes, ticked when booking", "Yes, ticked when moving online", "Not needed, clean is after 14 days" and "No, ask the customer". The existing column is renamed in place and its old values reworded the first time the admin app opens (or the next booking), so old and new rows stay in one column. `Code.gs` only. Nothing to run.

8 October 2026 (night):

- Booking times saved in the sheet (`Starts at`, `Ends at`), so unsigned jobs stay under "Waiting for sign-off" however old, and a booking whose calendar event was deleted by hand stays listed as "Not in calendar" with a button to put it back (FRE-203). The morning check lists both. Needs `Code.gs` and `Dashboard.html` pasted into Apps Script, and both deployments redeployed. Nothing to run: open the admin app once and it copies the times in for open bookings.
- One-time booking IDs: Code.gs accepts `requestId` on `book` and never books the same one twice (FRE-203, FRE-6). The website side (booking.js sending it, and retrying) is separate.

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
