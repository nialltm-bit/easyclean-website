/*
 * Browser check of the private admin app (_backend/Dashboard.html) against the
 * real booking system code (_backend/Code.gs). Google is faked: the page's
 * google.script.run is wired to Code.gs running in Node with a fake sheet,
 * Drive, calendar and email (see fake-google.js). Nothing real is touched.
 *
 * From the repo root (needs the same setup as booking.test.js):
 *   cd _tests && npm install && npx playwright install chromium && cd ..
 *   node _tests/dashboard.test.js
 *
 * Prints PASS/FAIL per check and exits non-zero if anything failed. It also
 * checks that nothing sent back to the page contains a Date, which is what
 * makes the real google.script.run reply with null.
 * This folder starts with "_", so it is never published.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { loadBackend, seedFigures } = require("./fake-google");

const html = fs.readFileSync(path.join(__dirname, "..", "_backend", "Dashboard.html"), "utf8");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok || detail === undefined ? "" : "  (" + JSON.stringify(detail) + ")"));
  if (!ok) failures++;
}

// A plain PNG of a given size, made here so the test needs no image files.
function png(width, height) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) { raw[o + 1 + x * 3] = (x * 255 / width) | 0; raw[o + 2 + x * 3] = (y * 255 / height) | 0; raw[o + 3 + x * 3] = 128; }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Width and height of a JPEG, read from its header.
function jpegSize(bytes) {
  const b = Buffer.from(bytes.map((x) => x & 255));
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// Opens the admin app on a page wired to the fake booking system.
async function openAdmin(browser, backend, view, token, contextOptions) {
  const context = await browser.newContext(contextOptions || { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const init = JSON.stringify({ view: view || "home", token: token || "" });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url === "http://admin.test/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html.replace("<?!= initJson ?>", init) });
    // Anything else (fonts, the logo) is answered with nothing, so the test never goes online.
    return route.fulfill({ status: 200, contentType: /\.css|fonts\.googleapis/.test(url) ? "text/css" : "image/png", body: "" });
  });
  await page.exposeFunction("__bridge", (fn, args) => {
    if (typeof backend.ctx[fn] !== "function" || /_$/.test(fn)) throw new Error("No such server function: " + fn);
    return backend.checkPlain(backend.ctx[fn].apply(null, args), fn);
  });
  await page.addInitScript(() => {
    const runner = (ok, fail) => new Proxy({}, {
      get(_, name) {
        if (name === "withSuccessHandler") return (f) => runner(f, fail);
        if (name === "withFailureHandler") return (f) => runner(ok, f);
        return (...args) => { window.__bridge(name, args).then((r) => ok && ok(r), (e) => fail && fail({ message: String(e && e.message || e).replace(/^Error: /, "") })); };
      },
    });
    window.google = { script: { run: runner() } };
  });
  await page.goto("http://admin.test/");
  return { page, context, errors };
}

const TEXT = (page, sel) => page.textContent(sel);

async function jobPage(browser) {
  console.log("\n== Admin app: job page (FRE-194)");
  const b = loadBackend({ live: true });
  b.setUpSheet();
  const home = b.addBooking({ Reference: "EC-10001", Name: "Sam Customer" }, new Date(Date.now() + 3600000).toISOString());
  const agent = b.addBooking({ Reference: "EC-20001", Name: "Pat Agent", "Business name": "Acme Lettings", Channel: "Agent/Landlord", "Payment method": "Invoice, 14 days", "Site contact name": "Pat Agent", "Site contact phone": "07000 000002", Total: "£300", Items: "3× Medium room: £135", estText: "~2h 25m" }, new Date(Date.now() + 7200000).toISOString());

  // ---- timer
  let { page, context, errors } = await openAdmin(browser, b, "job", home["Job token"]);
  await page.waitForSelector("#t-start");
  check("the job page shows the estimate and a Start button", /Estimate 1h 55m\./.test(await TEXT(page, "#timer-body")) && await page.isVisible("#t-start"));
  await page.click("#t-start");
  await page.waitForSelector("#t-clock");
  check("Start shows a running clock and when it started", /Started \d{1,2}:\d{2}(am|pm)\./.test(await TEXT(page, "#timer-body")) && await page.isVisible("#t-finish"));
  const first = await TEXT(page, "#t-clock");
  await page.waitForFunction((was) => document.getElementById("t-clock").textContent !== was, first, { timeout: 4000 }).catch(() => {});
  const second = await TEXT(page, "#t-clock");
  check("the clock counts up", /^0:00:\d\d$/.test(second) && second !== first, [first, second]);
  check("the sheet has the start", b.row("EC-10001")["Started at"] instanceof b.ctx.Date);
  b.advanceMinutes(130);
  await page.click("#t-finish");
  await page.waitForFunction(() => !document.getElementById("t-clock") && /longer than/.test(document.getElementById("timer-body").textContent));
  const done = await TEXT(page, "#timer-body");
  check("Finish shows how long it took against the estimate", /2h 10m/.test(done) && /15 min longer than the estimate of 1h 55m/.test(done), done);
  check("the sheet has the minutes", b.row("EC-10001")["Actual mins"] === 130, b.row("EC-10001")["Actual mins"]);
  await page.click("#t-reset");
  await page.waitForSelector("#t-start");
  check("Undo clears it and shows Start again", b.row("EC-10001")["Started at"] === "" && /Estimate 1h 55m/.test(await TEXT(page, "#timer-body")));

  // ---- photos
  check("before any photos it says so, with no folder link", /No photos yet/.test(await TEXT(page, "#ph-msg")) && (await page.$("#ph-msg a")) === null);
  check("a homeowner job has no photos-in-PDF tick", (await page.$("#ph-pdf")) === null);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#ph-before-btn")]);
  check("the Before button opens the photo chooser, allowing several photos", (await page.getAttribute("#ph-before", "multiple")) !== null && (await page.getAttribute("#ph-before", "accept")) === "image/*");
  await chooser.setFiles([{ name: "a.png", mimeType: "image/png", buffer: png(2400, 1800) }, { name: "b.png", mimeType: "image/png", buffer: png(1200, 800) }]);
  await page.waitForFunction(() => /2 photos saved\./.test(document.getElementById("ph-msg").textContent), null, { timeout: 15000 });
  const root = b.state.folders.filter((f) => f.name === "EasyClean Somerset — Job photos")[0];
  const folder = root.children[0];
  check("both photos were saved to the job's folder", folder.name === "EC-10001 Sam Customer" && folder.files.length === 2, folder.files.map((f) => f.getName()));
  check("the status says how many, with a link to the folder", /2 photos saved\. Saved: 2 before, 0 after\./.test(await TEXT(page, "#ph-msg")) && (await page.getAttribute("#ph-msg a", "href")) === folder.getUrl());
  const big = jpegSize(folder.files[0].getBlob().getBytes()), small = jpegSize(folder.files[1].getBlob().getBytes());
  check("a big photo is shrunk to 1800 pixels on its long side before it is sent", big && big.width === 1800 && big.height === 1350, big);
  check("a small photo is not enlarged", small && small.width === 1200 && small.height === 800, small);
  check("the saved files are JPEGs", folder.files.every((f) => f.getBlob().getBytes()[0] === (0xff - 256) && f.getName().endsWith(".jpg")));
  await page.setInputFiles("#ph-after", [{ name: "c.png", mimeType: "image/png", buffer: png(800, 600) }]);
  await page.waitForFunction(() => /Photo saved\./.test(document.getElementById("ph-msg").textContent), null, { timeout: 15000 });
  check("an After photo is counted on its own", /Saved: 2 before, 1 after\./.test(await TEXT(page, "#ph-msg")));
  check("both photo buttons are usable again", !(await page.isDisabled("#ph-before-btn")) && !(await page.isDisabled("#ph-after-btn")));

  const real = b.ctx.adminAddPhoto;
  b.ctx.adminAddPhoto = () => ({ ok: false, error: "That photo is too big." });
  await page.setInputFiles("#ph-after", [{ name: "d.png", mimeType: "image/png", buffer: png(100, 100) }]);
  await page.waitForFunction(() => /Couldn't save photo 1/.test(document.getElementById("ph-msg").textContent));
  check("a failed photo says so plainly, and the buttons come back", /Couldn't save photo 1: That photo is too big\./.test(await TEXT(page, "#ph-msg")) && !(await page.isDisabled("#ph-after-btn")));
  b.ctx.adminAddPhoto = real;
  await page.setInputFiles("#ph-after", [{ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") }]);
  await page.waitForFunction(() => /Couldn't read that photo/.test(document.getElementById("ph-msg").textContent));
  check("a file that isn't a photo is reported", /Couldn't read that photo\./.test(await TEXT(page, "#ph-msg")) && folder.files.length === 3);

  await page.click("text=All jobs");
  await page.waitForSelector("#q");
  await page.evaluate((t) => window.openJob(t), home["Job token"]);
  await page.waitForSelector("#ph-msg");
  check("reopening the job shows the saved counts and folder link", /Saved: 2 before, 1 after\./.test(await TEXT(page, "#ph-msg")) && (await page.getAttribute("#ph-msg a", "href")) === folder.getUrl());
  check("no page errors", errors.length === 0, errors);
  await context.close();

  // ---- an agent job, signed off with photos
  ({ page, context, errors } = await openAdmin(browser, b, "job", agent["Job token"]));
  await page.waitForSelector("#ph-pdf");
  check("an agent job has the photos-in-PDF tick, on to start with", await page.isChecked("#ph-pdf"));
  await page.uncheck("#ph-pdf");
  await page.waitForFunction(() => true);
  check("turning it off is saved", await (async () => { for (let i = 0; i < 20; i++) { if (b.row("EC-20001")["Photos in PDF"] === "No") return true; await page.waitForTimeout(50); } return false; })());
  await page.check("#ph-pdf");
  check("and back on", await (async () => { for (let i = 0; i < 20; i++) { if (b.row("EC-20001")["Photos in PDF"] === "") return true; await page.waitForTimeout(50); } return false; })());
  await page.setInputFiles("#ph-before", [{ name: "a.png", mimeType: "image/png", buffer: png(900, 600) }]);
  await page.waitForFunction(() => /Photo saved\./.test(document.getElementById("ph-msg").textContent), null, { timeout: 15000 });
  await page.click("#t-start");
  await page.waitForSelector("#t-clock");
  b.advanceMinutes(150);
  await page.locator("#pad").scrollIntoViewIfNeeded();
  const box = await page.locator("#pad").boundingBox();
  await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 90); await page.mouse.up();
  await page.click("#btn-submit");
  await page.waitForSelector("text=Signed off");
  check("an agent job signs off", b.row("EC-20001")["Completed at"] instanceof b.ctx.Date);
  check("the timer was finished at sign-off", b.row("EC-20001")["Actual mins"] === 150, b.row("EC-20001")["Actual mins"]);
  check("the income was recorded", b.row("EC-20001").Income === 300, b.row("EC-20001").Income);
  const pdfMail = b.state.emails.filter((e) => e.attachments.some((a) => /^Job-completion-/.test(a.getName())))[0];
  const pdf = pdfMail.attachments.filter((a) => /^Job-completion-/.test(a.getName()))[0];
  check("the completion PDF emailed to the agent has the photo", pdf.html.indexOf('class="ph"') !== -1 && pdf.html.indexOf("Photos taken on the day") !== -1);
  await page.click("text=Back to all jobs");
  await page.waitForSelector("#q");
  await page.evaluate((t) => window.openJob(t), agent["Job token"]);
  await page.waitForSelector("text=Signed off");
  const finished = await TEXT(page, "#app");
  check("a signed-off job shows its time against the estimate", /Time on job\s*2h 30m \(estimate 2h 25m\)/.test(finished.replace(/\s+/g, " ").replace("Time on job ", "Time on job")) || /2h 30m \(estimate 2h 25m\)/.test(finished), finished.slice(0, 300));
  check("and still has the photos card, without the PDF tick", (await page.$("#ph-before-btn")) !== null && (await page.$("#ph-pdf")) === null);
  check("no page errors", errors.length === 0, errors);
  await context.close();
}

async function tabs(browser) {
  console.log("\n== Admin app: tabs and Figures (FRE-187)");
  const b = loadBackend({ now: "2026-10-02T07:00:00Z" });
  b.setUpSheet();
  seedFigures(b);
  const { page, context, errors } = await openAdmin(browser, b, "home");
  await page.waitForSelector(".tabs");
  const labels = await page.$$eval(".tab", (els) => els.map((e) => e.firstChild.textContent.trim()));
  check("the tabs are Jobs, Unpaid, Time off, Figures", JSON.stringify(labels) === JSON.stringify(["Jobs", "Unpaid", "Time off", "Figures"]), labels);
  check("four tabs fit across a phone", await page.$eval(".tabs", (el) => el.scrollWidth <= el.clientWidth + 1));
  await page.click("text=Figures");
  await page.waitForSelector("#fig h2");
  const titles = await page.$$eval("#fig h2", (els) => els.map((e) => e.textContent));
  check("Figures shows this month, last month, year to date, VAT and unpaid", JSON.stringify(titles) === JSON.stringify(["This month so far (October 2026)", "September 2026", "Year to date (since 6 Apr 2026)", "VAT threshold, last 12 months", "Unpaid now"]), titles);
  const text = (await page.innerText("#fig")).replace(/\s+/g, " ");
  check("it has the September numbers", /Jobs completed 3 Job revenue £440 Cancellation and call-out fees £25 \(1\) Total income £465/.test(text), text.slice(0, 500));
  check("it has the VAT turnover and unpaid", /Turnover £1,295/.test(text) && /Unpaid invoices 2 \(£325\)/.test(text));
  check("it says how income is counted", /Income is counted on the day a job is signed off/.test(text));
  check("the VAT bar has a label for screen readers", /percent of the threshold used/.test(await page.getAttribute("#fig .bar", "aria-label")));
  await page.click("text=Unpaid");
  await page.click("text=Time off");
  await page.waitForSelector("#bk-list");
  await page.click("text=Jobs");
  await page.waitForSelector("#q");
  check("the other tabs still work", true);
  check("no page errors", errors.length === 0, errors);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await jobPage(browser);
    await tabs(browser);
  } finally {
    await browser.close();
  }
  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
