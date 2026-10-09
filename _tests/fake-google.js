/*
 * Runs _backend/Code.gs in Node with Google's services faked: the customer
 * sheet, Drive, the calendar, email, properties, locks and time. Nothing
 * here touches the real booking system. Used by backend.test.js and
 * dashboard.test.js. This folder starts with "_", so it is never published.
 *
 *   const { loadBackend } = require("./fake-google");
 *   const b = loadBackend({ now: "2026-10-07T07:00:00Z" });
 *   b.setUpSheet();                       // like running setUpCustomerSheet
 *   b.addRow({ Reference: "EC-1", ... }); // a row in the Bookings sheet
 *   b.ctx.adminStartJob(token);           // any function in Code.gs
 *
 * Dates put into the sheet by a test must be made with b.date(...), so they
 * are the same kind of Date Code.gs sees.
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Google's Utilities.formatDate, for the patterns Code.gs uses.
function formatDate(d, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "long",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  const year = +parts.year, month = +parts.month, day = +parts.day;
  const hour = +parts.hour, minute = +parts.minute, second = +parts.second;
  const dow = DAYS.indexOf(parts.weekday);
  const pad = (n, len) => String(n).padStart(len, "0");
  return pattern.replace(/'([^']*)'|(y+|M+|E+|d+|H+|h+|m+|s+|a+|u+)/g, (all, lit, tok) => {
    if (lit !== undefined) return lit;
    const c = tok[0], n = tok.length;
    if (c === "y") return n === 2 ? pad(year % 100, 2) : pad(year, 4);
    if (c === "M") return n >= 4 ? MONTHS[month - 1] : n === 3 ? MONTHS[month - 1].slice(0, 3) : pad(month, n);
    if (c === "E") return n >= 4 ? DAYS[dow] : DAYS[dow].slice(0, 3);
    if (c === "d") return pad(day, n);
    if (c === "H") return pad(hour, n);
    if (c === "h") return pad(hour % 12 || 12, n);
    if (c === "m") return pad(minute, n);
    if (c === "s") return pad(second, n);
    if (c === "a") return hour < 12 ? "AM" : "PM";
    if (c === "u") return String(dow === 0 ? 7 : dow);
    return all;
  });
}

function iterator(list) {
  let i = 0;
  return { hasNext: () => i < list.length, next: () => list[i++] };
}

function columnNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

class FakeSheet {
  constructor(name, header) {
    this.name = name;
    this.rows = header ? [header.slice()] : [];
    this.cellFormat = {};   // "r,c" -> number format
    this.columnFormat = {}; // c -> number format, for whole-column ranges
    this.maxRows = 1000;
    this.frozen = 0;
  }
  width() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  formatAt(r, c) { return this.cellFormat[r + "," + c] || this.columnFormat[c] || ""; }
  setName(name) { this.name = name; return this; }
  getLastColumn() { return this.width(); }
  getLastRow() {
    for (let i = this.rows.length; i > 0; i--) if (this.rows[i - 1].some((v) => v !== "" && v !== undefined)) return i;
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  setFrozenRows(n) { this.frozen = n; }
  appendRow(values) { this.rows.push(values.slice()); this.maxRows = Math.max(this.maxRows, this.rows.length); }
  clear() { this.rows = []; this.cellFormat = {}; return this; }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.width())); }
  getRange(r, c, nr, nc) {
    const sheet = this;
    nr = nr || 1; nc = nc || 1;
    const range = {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sheet.rows[r - 1 + i] || [];
          const vals = [];
          for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; vals.push(v === undefined ? "" : v); }
          out.push(vals);
        }
        return out;
      },
      getValue() { return range.getValues()[0][0]; },
      setValues(values) {
        for (let i = 0; i < values.length; i++) for (let j = 0; j < values[i].length; j++) sheet.put(r + i, c + j, values[i][j]);
        return range;
      },
      setValue(v) { sheet.put(r, c, v); return range; },
      setNumberFormat(fmt) {
        if (nr >= 100) { for (let j = 0; j < nc; j++) sheet.columnFormat[c + j] = fmt; }
        else for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.cellFormat[(r + i) + "," + (c + j)] = fmt;
        return range;
      },
      setFontWeight() { return range; },
    };
    return range;
  }
  getRangeList(cells) {
    const sheet = this;
    return {
      setNumberFormat(fmt) {
        cells.forEach((a1) => {
          const m = /^([A-Z]+)(\d+)$/.exec(a1);
          sheet.cellFormat[m[2] + "," + columnNumber(m[1])] = fmt;
        });
      },
    };
  }
  // Like Google Sheets: a cell that isn't plain text turns "£25" or "25" into a number.
  put(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c - 1) row.push("");
    if (typeof v === "string" && this.formatAt(r, c) !== "@" && /^£?-?\d+(\.\d+)?$/.test(v)) v = parseFloat(v.replace("£", ""));
    row[c - 1] = v;
    this.maxRows = Math.max(this.maxRows, this.rows.length);
  }
}

class FakeSpreadsheet {
  constructor(id, name) {
    this.id = id; this.name = name;
    this.sheets = [new FakeSheet("Sheet1", null)];
  }
  getId() { return this.id; }
  getUrl() { return "https://docs.google.com/spreadsheets/d/" + this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.filter((s) => s.name === name)[0] || null; }
  insertSheet(name) { const s = new FakeSheet(name, null); this.sheets.push(s); return s; }
}

function loadBackend(options) {
  options = options || {};
  // The clock is fixed at options.now, or follows real time with { live: true }
  // (for the browser test, where a timer runs on screen). advanceMinutes moves
  // either one forward.
  let baseMs = new Date(options.now || "2026-10-07T07:00:00Z").getTime();
  let offsetMs = 0;
  const RealDate = Date;
  const getNow = () => (options.live ? RealDate.now() : baseMs) + offsetMs;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(getNow()); else super(...args); }
    static now() { return getNow(); }
  }

  const state = {
    emails: [], props: {}, cache: {}, spreadsheets: {}, events: [], folders: [], foldersById: {},
    owner: options.owner === false ? "" : "owner@example.com", locksHeld: 0, lockUses: 0, idCounter: 0,
  };
  const nextId = (prefix) => prefix + String(++state.idCounter).padStart(26 - prefix.length, "0");

  class FakeFile {
    constructor(blob, parent) {
      this.blob = blob; this.id = nextId("fakefile"); this.parent = parent; this.sharing = "PRIVATE";
    }
    getName() { return this.blob.name; }
    getId() { return this.id; }
    getUrl() { return "https://drive.google.com/file/d/" + this.id + "/view"; }
    getBlob() { return this.blob; }
    getSharingAccess() { return this.sharing; }
    setSharing(access) { this.sharing = access; return this; }
  }
  class FakeFolder {
    constructor(name, parent) {
      this.name = name; this.id = nextId("fakefolder"); this.parent = parent; this.files = []; this.children = [];
      this.sharing = "PRIVATE"; this.trashed = false;
      state.foldersById[this.id] = this;
    }
    getName() { return this.name; }
    getId() { return this.id; }
    getUrl() { return "https://drive.google.com/drive/folders/" + this.id; }
    createFolder(name) { const f = new FakeFolder(name, this); this.children.push(f); return f; }
    getFoldersByName(name) { return iterator(this.children.filter((f) => f.name === name && !f.trashed)); }
    createFile(blob) { const f = new FakeFile(blob, this); this.files.push(f); return f; }
    getFiles() { return iterator(this.files.slice()); }
    setTrashed(t) { this.trashed = t; if (t) delete state.foldersById[this.id]; return this; }
  }

  const calendar = {
    createEvent(title, start, end, opts) {
      const ev = {
        title, start, end, description: (opts && opts.description) || "", location: (opts && opts.location) || "",
        id: nextId("fakeevent"),
        getTitle() { return this.title; }, setTitle(t) { this.title = t; },
        getStartTime() { return this.start; }, getEndTime() { return this.end; },
        getDescription() { return this.description; }, setDescription(d) { this.description = d; },
        setLocation(l) { this.location = l; }, setTime(s, e) { this.start = s; this.end = e; },
        getId() { return this.id; },
        deleteEvent() { state.events = state.events.filter((x) => x !== this); },
      };
      state.events.push(ev);
      return ev;
    },
    getEvents(from, to) { return state.events.filter((e) => e.start < to && e.end > from); },
    getEventsForDay(day) {
      const key = (d) => formatDate(d, "Europe/London", "yyyy-MM-dd");
      return state.events.filter((e) => key(e.start) === key(day));
    },
  };

  const logs = [], errors = [];
  const ctx = {
    // Code.gs logs problems it has handled with console.error; keep them out of the test output.
    console: { log() {}, warn() {}, info() {}, error: (m) => errors.push(String(m)) },
    Logger: { log: (m) => logs.push(String(m)) },
    Date: FakeDate,
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      base64Decode: (s) => Array.from(Buffer.from(s, "base64")).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(Array.from(bytes).map((b) => b & 255)).toString("base64"),
      newBlob(bytes, type, name) { return makeBlob(bytes, type, name); },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in state.props ? state.props[k] : null),
        setProperty: (k, v) => { state.props[k] = String(v); },
        deleteProperty: (k) => { delete state.props[k]; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in state.cache ? state.cache[k] : null),
        put: (k, v) => { state.cache[k] = v; },
        remove: (k) => { delete state.cache[k]; },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() { state.locksHeld++; state.lockUses++; },
        releaseLock() { state.locksHeld--; },
      }),
    },
    SpreadsheetApp: {
      create(name) { const id = nextId("fakesheet"); const ss = new FakeSpreadsheet(id, name); state.spreadsheets[id] = ss; return ss; },
      openById(id) { if (!state.spreadsheets[id]) throw new Error("No spreadsheet " + id); return state.spreadsheets[id]; },
    },
    DriveApp: {
      Access: { PRIVATE: "PRIVATE", ANYONE_WITH_LINK: "ANYONE_WITH_LINK" },
      Permission: { NONE: "NONE", VIEW: "VIEW" },
      getFoldersByName: (name) => iterator(state.folders.filter((f) => f.name === name && !f.trashed)),
      createFolder(name) { const f = new FakeFolder(name, null); state.folders.push(f); return f; },
      getFolderById(id) { if (!state.foldersById[id]) throw new Error("No folder " + id); return state.foldersById[id]; },
    },
    CalendarApp: { getDefaultCalendar: () => calendar },
    GmailApp: {
      sendEmail(to, subject, body, opts) {
        state.emails.push({ to, subject, body, html: opts && opts.htmlBody, attachments: (opts && opts.attachments) || [], opts: opts || {} });
      },
    },
    MailApp: { getRemainingDailyQuota: () => 100 },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger() {},
      newTrigger() {
        const t = { timeBased: () => t, everyMinutes: () => t, everyDays: () => t, atHour: () => t, create: () => t };
        return t;
      },
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => state.owner }),
      getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }),
    },
    HtmlService: {
      createHtmlOutput(html) {
        const out = {
          setTitle() { return out; }, setFaviconUrl() { return out; }, addMetaTag() { return out; },
          getContent() { return html; },
          getAs(type) { const b = makeBlob(Array.from(Buffer.from(html, "utf8")), type, "doc"); b.html = html; return b; },
        };
        return out;
      },
    },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    UrlFetchApp: {
      fetch() { throw new Error("No network in tests"); },
    },
  };

  function makeBlob(bytes, type, name) {
    const blob = {
      bytes: Array.from(bytes), type, name,
      getBytes() { return this.bytes; },
      getName() { return this.name; },
      setName(n) { this.name = n; return this; },
      getContentType() { return this.type; },
    };
    return blob;
  }

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "_backend", "Code.gs"), "utf8"), ctx, { filename: "Code.gs" });

  const api = {
    ctx, state, logs, errors,
    date: (iso) => new ctx.Date(iso),
    setNow(iso) { baseMs = new RealDate(iso).getTime(); offsetMs = 0; },
    advanceMinutes(n) { offsetMs += n * 60000; },
    // Like running setUpCustomerSheet once.
    setUpSheet() { ctx.setUpCustomerSheet(); return api.sheet(); },
    sheet() { return ctx.getCustomerSheet(); },
    // Adds a row to the Bookings sheet by header name, adding any header the
    // sheet doesn't have yet (as the real sheet grows).
    addRow(values) {
      const sheet = api.sheet();
      const header = sheet.rows[0];
      Object.keys(values).forEach((k) => { if (header.indexOf(k) === -1) header.push(k); });
      const row = header.map((h) => (h in values ? values[h] : ""));
      sheet.rows.push(row);
      sheet.maxRows = Math.max(sheet.maxRows, sheet.rows.length);
      return sheet.rows.length; // the row number
    },
    // The row for a reference as an object keyed by header.
    row(reference) {
      const sheet = api.sheet();
      const header = sheet.rows[0];
      const r = sheet.rows.slice(1).filter((x) => x[header.indexOf("Reference")] === reference)[0];
      if (!r) return null;
      const out = {};
      header.forEach((h, i) => { out[h] = r[i] === undefined ? "" : r[i]; });
      return out;
    },
    // A booking with its calendar event, as the website would have made it.
    addBooking(fields, startIso, lengthMins) {
      const v = Object.assign({
        Timestamp: api.date("2026-10-01T09:00:00Z"), Reference: "EC-10001", Name: "Sam Customer", Phone: "07000 000001",
        Email: "sam@example.com", Address: "1 High Street, BA1 1AA", Items: "2× Medium room: £90", Total: "£90",
        "Payment method": "Cash", "Booking time": "Wed 7 Oct, 9:00am", Channel: "Consumer",
        "Job token": crypto.randomBytes(16).toString("hex"), "Booked via": "Website",
      }, fields || {});
      api.addRow(v);
      if (startIso) {
        const start = api.date(startIso);
        calendar.createEvent("Clean: " + v.Name, start, new ctx.Date(start.getTime() + (lengthMins || 150) * 60000), {
          description: "Reference: " + v.Reference + "\nWhat needs cleaning: " + v.Items + "\nEst. time: " + (v.estText || "~1h 55m"),
        });
      }
      return v;
    },
    sentTo: (to) => state.emails.filter((e) => e.to === to),
    // Throws if anything in a result is a Date, like google.script.run, which
    // turns the whole reply into null when it finds one.
    checkPlain(value, where) {
      const walk = (x, p) => {
        if (x && typeof x === "object") {
          if (x instanceof ctx.Date || x instanceof RealDate) throw new Error("A Date in the reply at " + p + " (" + where + ")");
          Object.keys(x).forEach((k) => walk(x[k], p + "." + k));
        }
      };
      walk(value, "");
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    },
  };
  return api;
}

// Sample bookings for the figures: a month of September jobs, cancellations
// with and without fees, an unpaid agent invoice, older jobs either side of
// the year to date and last 12 months windows, and a booking made today. The
// tests that use it run with the clock at 2 October 2026.
function seedFigures(b) {
  const d = (x) => b.date(x);
  b.addBooking({ Reference: "EC-81", Timestamp: d("2026-09-01T09:00:00Z"), "Completed at": d("2026-09-05T10:00:00Z"), Total: "£140", "Payment method": "Cash", "Referral / offer code": "friend10", "Est. mins": 120, "Actual mins": 100 });
  b.addBooking({ Reference: "EC-82", Timestamp: d("2026-09-08T09:00:00Z"), "Completed at": d("2026-09-12T10:00:00Z"), Total: "£300", "Payment method": "Invoice, 14 days", Channel: "Agent/Landlord", "Business name": "Acme", "Booked via": "Admin app", "Payment due": d("2026-09-26T10:00:00Z"), "Invoice number": 1001 });
  b.addBooking({ Reference: "EC-83", Timestamp: d("2026-09-10T09:00:00Z"), "Completed at": d("2026-09-20T10:00:00Z"), Total: "£90", "Payment method": "No charge" });
  b.addBooking({ Reference: "EC-84", Timestamp: d("2026-09-02T09:00:00Z"), "Cancelled at": d("2026-09-15T10:00:00Z"), "Cancelled by": "No access on the day", Total: "£200", "Cancellation fee": 25, "Referral / offer code": " FRIEND10", "Payment due": d("2026-09-29T10:00:00Z"), "Invoice number": 1002 });
  b.addBooking({ Reference: "EC-85", Timestamp: d("2026-09-03T09:00:00Z"), "Cancelled at": d("2026-09-16T10:00:00Z"), "Cancelled by": "Customer cancelled", Total: "£150" });
  b.addBooking({ Reference: "EC-86", Timestamp: d("2026-09-04T09:00:00Z"), "Cancelled at": d("2026-09-18T10:00:00Z"), "Cancelled by": "We cancelled", Total: "£150" });
  b.addBooking({ Reference: "EC-87", Timestamp: d("2026-04-10T09:00:00Z"), "Completed at": d("2026-04-20T10:00:00Z"), Total: "£200", "Payment method": "Cash" });
  b.addBooking({ Reference: "EC-88", Timestamp: d("2026-03-10T09:00:00Z"), "Completed at": d("2026-03-20T10:00:00Z"), Total: "£500", "Payment method": "Cash" });
  b.addBooking({ Reference: "EC-89", Timestamp: d("2025-09-20T09:00:00Z"), "Completed at": d("2025-09-30T10:00:00Z"), Total: "£1000", "Payment method": "Cash" });
  b.addBooking({ Reference: "EC-90", Timestamp: d("2025-09-20T09:00:00Z"), "Completed at": d("2025-10-02T10:00:00Z"), Total: "£700", "Payment method": "Cash" });
  b.addBooking({ Reference: "EC-91", Timestamp: d("2025-09-20T09:00:00Z"), "Completed at": d("2025-10-03T10:00:00Z"), Total: "£50", "Payment method": "Cash" });
  b.addBooking({ Reference: "EC-92", Timestamp: d("2026-10-01T08:00:00Z"), "Completed at": d("2026-10-01T15:00:00Z"), Total: "£80", "Payment method": "Cash", "Referral / offer code": "spring" });
  b.addBooking({ Reference: "EC-93", Timestamp: d("2026-10-01T09:00:00Z"), Total: "£100", "Payment method": "Cash", "Referral / offer code": "SPRING" });
}

module.exports = { loadBackend, formatDate, seedFigures };
