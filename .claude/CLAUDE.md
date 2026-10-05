# EasyClean Somerset: rules for working on this repo

This repo is the EasyClean Somerset website (easycleansomerset.co.uk). GitHub Pages builds it with Jekyll from `main`. The `_backend` folder holds copies of the booking system's files.

## Before you start

- **Two Claudes work on this business:** Claude Code and Claude in the Cowork app.
  - Both change the website, and both can change the booking system.
- **Pull the latest from GitHub before starting.** The other one may have changed something since your last session.
- **Never hand over old copies.** Don't give Niall files to upload that were made before the latest `main`. They would undo the other Claude's work.

## The booking system

- **Where it runs:** in Google Apps Script (project "EasyClean booking backend"), not on GitHub.
  - `_backend/Code.gs` and `_backend/Dashboard.html` are copies of its two files.
  - Read `_backend/README.md` before working on it.
- **To change it:**
  1. Change the copy in `_backend` and commit it.
  2. Tell Niall, in plain steps, to paste the whole file into Apps Script and save.
  3. Then tell him to redeploy BOTH deployments as a new version: Deploy > Manage deployments > edit each one > Version: New version > Deploy.
  4. If the change needs a function run once, say which one. He picks it in the function dropdown and presses Run.
- **Keep the two in step:** the copy in `_backend` and Apps Script must stay the same.

## Never put private settings in files

Never put bank details or other private settings in any file. That includes `ADMIN_URL`, the customer sheet ID and the invoice counter. They live only in Apps Script under Project Settings > Script Properties. This repo is public.

## Check before changing what the booking system reads

Read "How the website and the booking system connect" in `_backend/README.md` before changing any of these:

- **The price rows** (built from `_data/prices.yml`).
  - Code.gs reads the price rows from the built `index.html` and `agents.html`.
  - Each row must stay exactly `<div class="item-row" data-item="..." data-price="..." data-mins="...">`.
  - Don't add a class to it or rename those attributes.
- **`service-area.js`.**
  - Code.gs reads it and expects the `window.EC_SERVICE_AREA = [ "BA1", ... ];` format.
- **Anything `booking.js` or `job-complete.html` sends to the booking system,** or reads back from it.

## Niall's preferences

- **Dashes:** never use em dashes.
- **Wording:** keep it plain and short.
- **File names:** give files clearly different names.
- **Files:** give whole files, not snippets.

## Useful to know

- **Unpublished folders:** folders starting with `_` or `.` (like `_backend`, `_tests`, `.claude`) are never published on the website.
- **Booking test:** `_tests/booking.test.js` checks both booking flows with the booking system faked.
  - Build the site with `jekyll build`, then run `node _tests/booking.test.js`.
  - Setup steps are at the top of the file.
- **Linear:** tickets are in the FreshTech team, project "FreshTech V1".
