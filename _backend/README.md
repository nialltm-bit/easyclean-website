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
- **Bookings:** `booking.js` sends `POST { action: "book", ... }` as JSON. Code.gs checks every field again and sends back `ok` or an error code that the page understands.
- **Prices:**
  - **Where Code.gs reads them:** it doesn't trust the price the page sends. It reads the price rows on the built `index.html` and `agents.html` pages, in `parsePriceRows`.
  - **What it looks for:** each row must stay as `<div class="item-row" data-item="..." data-price="..." data-mins="...">`, with `class="item-row"` exactly. An extra class or a renamed attribute stops the price check finding the rows.
  - **Where prices change:** in `_data/prices.yml`.
- **Service area:** Code.gs reads `service-area.js` and expects the `window.EC_SERVICE_AREA = [ "BA1", ... ];` format.
- **Sign-off page:** `job-complete.html` uses `GET ?action=job&t=<token>` and `POST { action: "complete", ... }`.
- **WhatsApp number:** `WHATSAPP_NUMBER` in Code.gs must match the one in `booking.js`.

## Morning check

The daily trigger (`sendDayOfReminders`, around 7am) ends with a health check. It emails Niall if anything needs a look, including problems noted since the last check, and sends a short "all fine" note on Mondays. Turned-away website bookings also email him straight away (at most one an hour). To run the check by hand, pick `checkBookingSystem` in the function dropdown and press Run.

## Last updated

6 October 2026: morning health check and turned-away booking alerts (FRE-185), and aftercare plus a 2-day follow-up email (FRE-193). This matches Apps Script once that version is deployed.
