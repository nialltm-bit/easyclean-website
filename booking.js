/*
 * EasyClean Somerset: the price calculator and booking form.
 *
 * One copy of this code runs both booking pages: the homeowner page
 * (index.html) and the landlord and agent page (agents.html). Each page
 * loads service-area.js and this file, then calls ecBooking({...}) with the
 * few things that differ between them:
 *
 *   channel      "Consumer" or "Agent/Landlord". Sent with the booking and
 *                to Google Analytics.
 *   payment      (optional) the payment method for every booking from that
 *                page. Leave it out to use the Cash / Bank transfer choice
 *                on the form.
 *   extraFields  extra boxes on that page's form to send with the booking,
 *                as { nameInTheBooking: "box-id" }.
 *   messages     the WhatsApp wording, plus the note shown for a postcode
 *                we don't cover. See either page for the full list.
 *
 * Which boxes must be filled in comes from the "required" attribute on the
 * form's boxes, so making a box required needs no change here. The agent
 * page's "Access on the day" choice is handled below whenever a page has it.
 * The form's order is postcode, time, contact details, then the closed
 * "Anything else?" section (#bf-extras). None of that order matters to the
 * code here: every box is found by its id.
 */
window.ecBooking = function (config) {
  "use strict";

  var messages = config.messages;

  // ---- Google Analytics: one event per step of the form ----
  // Lets us see where people give up. Only sent once the visitor has
  // accepted analytics cookies (the choice consent.js saves), so nothing
  // extra goes out before consent and nothing queued is sent later. No
  // personal data: just the step, the channel, item names and the postcode
  // area (like "BA3"), never a full postcode, name, email or phone number.
  function track(name, params) {
    try {
      var c = JSON.parse(localStorage.getItem("ecCookieConsent"));
      if (!c || c.v !== "granted" || typeof gtag !== "function") return;
      params = params || {};
      params.channel = config.channel;
      gtag("event", name, params);
    } catch (err) {}
  }

  // Business WhatsApp number.
  var WHATSAPP_NUMBER = "447873212249";

  function waLink(message) {
    return "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent(message);
  }

  var defaultMsg = messages.quickQuote;
  document.getElementById("nav-wa").href = waLink(defaultMsg);
  document.getElementById("wa-quick-quote").href = waLink(defaultMsg + "(I'll add photos here)");
  document.getElementById("foot-wa").href = waLink(defaultMsg);

  // ---- Postcodes we cover, shown by the prices ----
  // Read from service-area.js, so it always matches the postcode check.
  var areaLine = document.getElementById("area-line");
  if (areaLine && Array.isArray(window.EC_SERVICE_AREA)) {
    var districts = window.EC_SERVICE_AREA.slice().sort(function (a, b) {
      var pa = /^([A-Z]+)(\d+)$/.exec(a) || [a, a, 0];
      var pb = /^([A-Z]+)(\d+)$/.exec(b) || [b, b, 0];
      if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
      return pa[2] - pb[2];
    });
    areaLine.textContent = "Online booking covers postcodes " + districts.join(", ") +
      ". Somewhere else? WhatsApp us and we’ll see if we can help.";
  }

  // ---- Job time estimate ----
  // A fixed 45-minute overhead (travel, set-up, colourfastness check,
  // pack-down) is added to every job with at least one item picked.
  // SLOT_MINS is the standard calendar slot. Nothing on this page checks a
  // basket against it at the moment: the online size limit is switched off.
  var FIXED_OVERHEAD_MINS = 45;
  var SLOT_MINS = 150; // 2.5 hours

  function formatMins(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h === 0) return m + " min";
    if (m === 0) return h + "h";
    return h + "h " + m + "m";
  }

  // ---- Price + time calculator ----
  var rows = Array.prototype.slice.call(document.querySelectorAll(".item-row"));
  var state = {};
  var currentSelection = { lines: [], total: 0, totalMins: 0 };

  function formatGBP(n) {
    return "£" + n.toLocaleString("en-GB");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- Screen reader announcements ----
  // Messages that appear on the page (basket changes, postcode and booking
  // errors) are also read out by screen readers through this hidden live
  // region. It has to be on the page before anything is put in it.
  var announcer = document.createElement("div");
  announcer.setAttribute("aria-live", "polite");
  announcer.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;";
  document.body.appendChild(announcer);
  var announceTimer = null;
  function announce(text) {
    // Cleared first, with a short pause, so the same message twice in a row
    // is still read out the second time.
    announcer.textContent = "";
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () { announcer.textContent = text; }, 100);
  }

  // Smooth scrolling, unless the visitor has asked their device for less
  // motion (the CSS already does the same for links).
  function scrollBehavior() {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reduce ? "auto" : "smooth";
  }

  function render() {
    var lines = [];
    var total = 0;
    var totalMins = 0;
    rows.forEach(function (row) {
      var name = row.getAttribute("data-item");
      var qty = state[name] || 0;
      if (qty > 0) {
        var price = parseInt(row.getAttribute("data-price"), 10);
        var mins = parseInt(row.getAttribute("data-mins"), 10);
        var lineTotal = price * qty;
        total += lineTotal;
        totalMins += mins * qty;
        lines.push(qty + "× " + name + ": " + formatGBP(lineTotal));
      }
    });
    if (total > 0) totalMins += FIXED_OVERHEAD_MINS;

    var summaryEl = document.getElementById("summary-lines");
    if (lines.length === 0) {
      summaryEl.innerHTML = '<div class="summary-empty">Nothing added yet, use the + buttons on the left.</div>';
    } else {
      summaryEl.innerHTML = lines.map(function (l) {
        return '<div class="summary-line"><span>' + escapeHtml(l.split(": ")[0]) + "</span><span>" + escapeHtml(l.split(": ")[1]) + "</span></div>";
      }).join("");
    }

    document.getElementById("summary-total").textContent = formatGBP(total);

    var timeRow = document.getElementById("summary-time");
    if (total > 0) {
      timeRow.style.display = "flex";
      document.getElementById("summary-time-val").textContent = "~" + formatMins(totalMins);
    } else {
      timeRow.style.display = "none";
    }

    var bookBtn = document.getElementById("btn-continue-book");
    // It's a link, so "disabled" alone doesn't stop it: also take it out of
    // the tab order and tell screen readers it's unavailable.
    if (total === 0) {
      bookBtn.setAttribute("disabled", "disabled");
      bookBtn.setAttribute("aria-disabled", "true");
      bookBtn.setAttribute("tabindex", "-1");
      bookBtn.style.pointerEvents = "none";
      bookBtn.style.opacity = "0.45";
    } else {
      bookBtn.removeAttribute("disabled");
      bookBtn.removeAttribute("aria-disabled");
      bookBtn.removeAttribute("tabindex");
      bookBtn.style.pointerEvents = "auto";
      bookBtn.style.opacity = "1";
    }

    var summaryText = lines.length
      ? messages.basketQuote(lines.join(", "), formatGBP(total))
      : defaultMsg;
    document.getElementById("btn-continue-wa").href = waLink(summaryText);

    // Feed the booking section below with the latest selection. This is
    // what makes the whole thing one continuous flow: by the time the
    // customer scrolls down to "book", their items/price/time are
    // already sitting there, and available slots have already started
    // loading in the background.
    currentSelection = { lines: lines, total: total, totalMins: totalMins };
    updateBookingSection();
    updateGroupCounts();
    updateBasketBar();
  }

  // ---- Collapsible item-group sections ----
  // Lets someone skip past a whole category (e.g. no rugs to clean) rather
  // than scrolling past every room/sofa/mattress row on the way to the one
  // they actually want. A small count badge appears on a collapsed group's
  // header if it still holds a selected item, so nothing picked gets lost
  // out of sight.
  function updateGroupCounts() {
    document.querySelectorAll(".item-group").forEach(function (group) {
      var count = 0;
      group.querySelectorAll(".item-row").forEach(function (row) {
        count += state[row.getAttribute("data-item")] || 0;
      });
      var badge = group.querySelector(".igt-count");
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count + " selected";
        badge.classList.add("show");
      } else {
        badge.classList.remove("show");
      }
    });
  }

  // Each group heading holds a real button, so Enter and Space work on
  // their own.
  function toggleGroup(btn) {
    var group = btn.closest(".item-group");
    var collapsed = group.classList.toggle("collapsed");
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    var toggleText = btn.querySelector(".igt-toggle-text");
    if (toggleText) toggleText.textContent = collapsed ? "See more" : "Hide";
  }

  document.querySelectorAll(".item-group-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () { toggleGroup(btn); });
  });

  rows.forEach(function (row) {
    var name = row.getAttribute("data-item");
    state[name] = 0;
    var qtyEl = row.querySelector(".qty");
    row.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var action = btn.getAttribute("data-action");
        if (action === "inc") {
          if (state[name] < 9) track("booking_item_added", { item_name: name });
          state[name] = Math.min(state[name] + 1, 9);
        }
        if (action === "dec") state[name] = Math.max(state[name] - 1, 0);
        qtyEl.textContent = state[name];
        render();
        announce(name + ": " + state[name] + ". Total " + formatGBP(currentSelection.total) + ".");
      });
    });
  });

  // "Book online" links (nav, footer) jump straight to the booking
  // section, but with nothing selected yet that section can only show
  // "select your items first" — a dead end. Redirect those clicks to
  // the price calculator instead whenever nothing's been picked yet, so
  // there's no extra step that just sends the visitor back up the page.
  document.getElementById("logo-home").addEventListener("click", function (e) {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  });

  document.querySelectorAll(".book-link").forEach(function (link) {
    link.addEventListener("click", function (e) {
      if (currentSelection.total === 0) {
        e.preventDefault();
        document.getElementById("prices").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      }
    });
  });

  // ---- Booking flow ----
  // The booking system's web address. It lists the free times and creates
  // the booking in the calendar.
  var APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzib7aiWlTG1JN1vawUToNL2r9OYoFp-fJYNsbvJdhHAHtLaddPr0wMKYnxYLwoQxt_GA/exec";

  var slotsLoaded = false;
  var slotsCache = [];
  var selectedSlot = null;
  var selectedDay = null;
  var dayPage = null; // which page of DAY_PAGE_SIZE days is currently shown
  var DAY_PAGE_SIZE = 7;
  var confirmedBookingRef = null;

  // Start checking the calendar for available times as soon as the page
  // loads, quietly in the background — not when someone first reaches the
  // booking section. Most visitors spend a few seconds on the price list
  // first, so by the time they reach "Choose a time" the result is
  // usually already sitting there waiting instead of making them watch a
  // loading message.
  slotsLoaded = true;
  fetchSlots();

  function updateBookingSection() {
    if (confirmedBookingRef) return; // a booking already went through — leave the confirmation showing

    var needItems = document.getElementById("booking-need-items");
    var summary = document.getElementById("booking-summary");
    var form = document.getElementById("booking-form");

    if (currentSelection.total === 0) {
      needItems.style.display = "block";
      summary.style.display = "none";
      form.style.display = "none";
      return;
    }
    needItems.style.display = "none";

    summary.style.display = "block";
    document.getElementById("booking-summary-lines").innerHTML = currentSelection.lines.map(function (l) {
      var parts = l.split(": ");
      return '<div class="bs-line"><span>' + escapeHtml(parts[0]) + "</span><span>" + escapeHtml(parts[1]) + "</span></div>";
    }).join("");
    document.getElementById("booking-summary-total").textContent = formatGBP(currentSelection.total);
    document.getElementById("booking-summary-time").textContent = "~" + formatMins(currentSelection.totalMins);

    form.style.display = "block";

    var altDayMsg = currentSelection.lines.length
      ? messages.noDayWorks(currentSelection.lines.join(", "), formatGBP(currentSelection.total))
      : defaultMsg;
    document.getElementById("bf-alt-day-wa").href = waLink(altDayMsg);

    if (!slotsLoaded) {
      slotsLoaded = true; // fetch once, not on every keystroke
      fetchSlots();
    }
  }

  function fetchSlots() {
    var daysEl = document.getElementById("bf-days");
    // A shimmering placeholder shaped like the real day cards, shown the
    // instant this fires (page load, not when someone scrolls down here) —
    // so there's always something moving on screen straight away rather
    // than a static "checking..." sentence that just sits there while the
    // calendar lookup happens in the background.
    var skeleton = "";
    for (var i = 0; i < DAY_PAGE_SIZE; i++) skeleton += '<div class="bf-day-skel"></div>';
    daysEl.innerHTML = skeleton;
    document.getElementById("bf-slots-label").textContent = "";
    document.getElementById("bf-slots").innerHTML = "";
    fetch(APPS_SCRIPT_URL + "?action=slots")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || "unknown");
        slotsCache = data.slots || [];
        renderDayPicker();
      })
      .catch(function () {
        document.getElementById("bf-days-nav").style.display = "none";
        daysEl.innerHTML = '<div class="bf-slots-empty">Couldn’t load available times just now. <button type="button" class="bf-retry" id="bf-slots-retry">Try again</button> or use WhatsApp Quick Quote instead.</div>';
        document.getElementById("bf-slots-retry").addEventListener("click", fetchSlots);
      });
  }

  // "EEE d MMM" (e.g. "Wed 9 Sep") split into its three parts.
  function splitDayLabel(day) {
    return day.split(" ");
  }

  // A short range label for the nav row, e.g. "9–16 Sep", or "28 Sep – 4
  // Oct" if the visible week of days happens to cross a month boundary.
  function formatDayRange(pageDays) {
    if (!pageDays.length) return "";
    var first = splitDayLabel(pageDays[0]);
    var last = splitDayLabel(pageDays[pageDays.length - 1]);
    if (first[2] === last[2]) {
      return first[1] + "–" + last[1] + " " + first[2];
    }
    return first[1] + " " + first[2] + " – " + last[1] + " " + last[2];
  }

  // The day picker also shows days with no times. It works out the window the
  // same way the booking system does, so these two must match it: the
  // first day is the one 24 hours from now (LEAD_TIME_HOURS) and the window
  // is 21 days from today (DAYS_AHEAD). If the booking system ever offers a time outside
  // that, the list stretches to include it, so a free time is never hidden.
  var LEAD_TIME_HOURS = 24;
  var DAYS_AHEAD = 21;
  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // [{ label: "Fri 2 Oct", hasTimes: false }, ...] one per calendar day (UK).
  // A day with times keeps the label the booking system gave it.
  function buildDayList() {
    var backendLabel = {};
    var first = ukDayNumber(new Date(new Date().getTime() + LEAD_TIME_HOURS * 3600000));
    var last = ukDayNumber(new Date()) + DAYS_AHEAD - 1;
    slotsCache.forEach(function (slot) {
      var n = ukDayNumber(new Date(slot.start));
      if (!(n in backendLabel)) backendLabel[n] = slot.dayLabel;
      first = Math.min(first, n);
      last = Math.max(last, n);
    });
    var list = [];
    for (var n = first; n <= last; n++) {
      var hasTimes = n in backendLabel;
      var d = new Date(n * 86400000); // midnight UTC of that UK date
      list.push({
        label: hasTimes ? backendLabel[n] : DAY_NAMES[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTH_NAMES[d.getUTCMonth()],
        hasTimes: hasTimes
      });
    }
    return list;
  }

  function renderDayPicker() {
    var daysEl = document.getElementById("bf-days");
    var navEl = document.getElementById("bf-days-nav");
    if (!slotsCache.length) {
      navEl.style.display = "none";
      daysEl.innerHTML = '<div class="bf-slots-empty">No online slots available at the moment. WhatsApp us and we’ll find you a time.</div>';
      document.getElementById("bf-slots-label").textContent = "";
      document.getElementById("bf-slots").innerHTML = "";
      return;
    }

    // Every calendar day in the window, in order, including days with no
    // times (Sundays, days that are fully booked): the booking system only
    // sends back free times, so without these the picker would jump from
    // Friday to Monday. A day with no times can still be clicked, and says so.
    var allDays = buildDayList();
    var days = allDays.map(function (d) { return d.label; });
    var daysWithTimes = {};
    allDays.forEach(function (d) { if (d.hasTimes) daysWithTimes[d.label] = true; });

    // Default to the first day that has times, or keep the current selection
    // if it's still in the list (e.g. after a re-fetch).
    if (!selectedDay || days.indexOf(selectedDay) === -1) {
      selectedDay = slotsCache[0].dayLabel;
    }

    // Show DAY_PAGE_SIZE days at a time rather than the full range in one
    // go — a real week fits on screen with no scrolling and no wrapping,
    // and the arrows above step to the next/previous batch of days.
    var totalPages = Math.max(1, Math.ceil(days.length / DAY_PAGE_SIZE));
    if (dayPage === null || dayPage >= totalPages) {
      // First render, or the range shrank (e.g. after a refetch) — default
      // to whichever page the selected day actually falls on.
      dayPage = Math.max(0, Math.floor(days.indexOf(selectedDay) / DAY_PAGE_SIZE));
    }
    var pageDays = days.slice(dayPage * DAY_PAGE_SIZE, dayPage * DAY_PAGE_SIZE + DAY_PAGE_SIZE);

    navEl.style.display = totalPages > 1 ? "flex" : "none";
    if (totalPages > 1) {
      document.getElementById("bf-days-range").textContent = formatDayRange(pageDays);
      document.getElementById("bf-days-prev").disabled = dayPage === 0;
      document.getElementById("bf-days-next").disabled = dayPage >= totalPages - 1;
    }

    // Lay out as a small card per day (day-of-week / day number / month)
    // instead of one flat pill of text.
    var html = "";
    pageDays.forEach(function (day) {
      var parts = splitDayLabel(day);
      var sel = day === selectedDay ? " selected" : "";
      var empty = !daysWithTimes[day];
      html += '<button type="button" class="bf-day-card' + sel + (empty ? " no-times" : "") + '" aria-pressed="' + (day === selectedDay) + '" data-day="' + escapeHtml(day) + '"' +
        (empty ? ' aria-label="' + escapeHtml(day) + ', no times available"' : "") + '>' +
        '<div class="dow">' + escapeHtml(parts[0]) + '</div>' +
        '<div class="dom">' + escapeHtml(parts[1]) + '</div>' +
        '<div class="mon">' + escapeHtml(parts[2]) + '</div>' +
        '</button>';
    });
    daysEl.innerHTML = html;
    daysEl.querySelectorAll(".bf-day-card").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var day = btn.getAttribute("data-day");
        if (day !== selectedDay) {
          track("booking_day_picked");
          // A time picked on the previous day would stay selected but out of
          // sight, and Confirm would still book it. Start the new day fresh.
          selectedSlot = null;
          updateSubmitEnabled();
        }
        selectedDay = day;
        renderDayPicker();
        refocus(daysEl, ".bf-day-card", "data-day", day);
        // Focus stays on the day, so say what that day holds when it holds nothing.
        if (!daysWithTimes[day]) announce("No times on " + day + ". Pick another day.");
      });
    });

    renderSlots();
  }

  // Picking a day or time rebuilds the buttons, which would drop keyboard
  // focus to the top of the page. Put it back on the button just pressed.
  function refocus(container, selector, attr, value) {
    var btns = container.querySelectorAll(selector);
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute(attr) === value) {
        btns[i].focus();
        return;
      }
    }
  }

  function renderSlots() {
    var slotsEl = document.getElementById("bf-slots");
    var labelEl = document.getElementById("bf-slots-label");
    var daySlots = slotsCache.filter(function (slot) { return slot.dayLabel === selectedDay; });

    labelEl.textContent = !selectedDay ? ""
      : daySlots.length === 0 ? "No times on " + selectedDay
      : daySlots.length + (daySlots.length === 1 ? " time" : " times") + " on " + selectedDay;

    if (!daySlots.length) {
      slotsEl.innerHTML = '<div class="bf-slots-empty">Pick another day, or WhatsApp us and we’ll find you a time.</div>';
      return;
    }

    var html = "";
    daySlots.forEach(function (slot) {
      var sel = slot.start === selectedSlot ? " selected" : "";
      html += '<button type="button" class="bf-slot-btn' + sel + '" aria-pressed="' + (slot.start === selectedSlot) + '" data-start="' + escapeHtml(slot.start) + '">' + escapeHtml(slot.timeLabel) + "</button>";
    });
    slotsEl.innerHTML = html;
    slotsEl.querySelectorAll(".bf-slot-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectedSlot = btn.getAttribute("data-start");
        track("booking_time_picked");
        renderSlots();
        refocus(slotsEl, ".bf-slot-btn", "data-start", selectedSlot);
        updateSubmitEnabled();
      });
    });
  }

  // ---- Service area ----
  // The list of postcode districts we take online bookings in lives in
  // service-area.js (one place, also read by the booking system). Outside
  // it, Confirm stays off and the visitor is offered WhatsApp instead.
  // If that file ever fails to load, the page lets the booking through and
  // the booking system still checks it.
  var areaTouched = false;
  var areaTracked = ""; // last postcode area sent to analytics, so each is sent once
  var areaNote = ""; // last postcode note read out, so it isn't repeated on every keystroke
  function postcodeArea() {
    if (typeof window.ecPostcodeCheck !== "function") return { status: "ok" };
    return window.ecPostcodeCheck(document.getElementById("bf-postcode").value);
  }
  function renderAreaMsg() {
    var el = document.getElementById("bf-area-msg");
    var r = postcodeArea();
    var note = "";
    if ((r.status === "ok" || r.status === "out") && r.outward && r.outward !== areaTracked) {
      areaTracked = r.outward;
      track("booking_postcode_checked", {
        result: r.status === "ok" ? "in_area" : "out_of_area",
        postcode_area: r.outward
      });
    }
    if (r.status === "out") {
      note = messages.outOfAreaNote(r.outward);
      el.innerHTML = '<p>' + escapeHtml(note) + '</p>' +
        '<a class="btn btn-wa" target="_blank" rel="noopener" href="' + waLink(messages.outOfArea(r.formatted, currentSelection.lines.join(", "), formatGBP(currentSelection.total))) + '">Message us on WhatsApp</a>';
      el.style.display = "block";
    } else if (r.status === "invalid" && areaTouched) {
      note = "Please enter the full postcode, for example BA1 1AA.";
      el.innerHTML = '<p>' + note + '</p>';
      el.style.display = "block";
    } else {
      el.style.display = "none";
      el.innerHTML = "";
    }
    if (note && note !== areaNote) announce(note);
    areaNote = note;
  }
  document.getElementById("bf-postcode").addEventListener("input", function () {
    // Only nag about the format once they've left the box, but show
    // in/out of area as soon as a full postcode is typed.
    renderAreaMsg();
  });
  document.getElementById("bf-postcode").addEventListener("blur", function () {
    areaTouched = true;
    var r = postcodeArea();
    if (r.formatted) this.value = r.formatted; // tidy to e.g. "BS14 8AB"
    renderAreaMsg();
  });

  // Confirm switches on once a time is picked, every box marked "required"
  // on the form is filled in, and the postcode is one we cover.
  // ---- Starting within the 14-day cancellation period (home page) ----
  // A homeowner who books online can cancel within 14 days. To clean inside
  // that time, the law needs them to ask us to. So when the chosen time is
  // within it, a tick box appears and Confirm waits for it. The booking
  // system records the answer. The agent page has no box (business bookings).
  var CANCEL_DAYS = 14;
  function ukDayNumber(d) {
    var p = d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }).split("-"); // YYYY-MM-DD
    return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000;
  }
  function withinCancellationPeriod(start) {
    return ukDayNumber(new Date(start)) - ukDayNumber(new Date()) <= CANCEL_DAYS;
  }
  function earlyStartOk() {
    var row = document.getElementById("bf-early-row");
    if (!row) return true;
    var needed = !!selectedSlot && withinCancellationPeriod(selectedSlot);
    if (row.hidden === needed) {
      row.hidden = !needed;
      if (needed) announce("This time is within your 14-day cancellation period. Please tick the box above Confirm to ask us to clean within it.");
    }
    return !needed || document.getElementById("bf-early-start").checked;
  }

  function updateSubmitEnabled() {
    var required = document.querySelectorAll("#booking-form input[required]");
    var filled = Array.prototype.every.call(required, function (el) {
      return el.value.trim() !== "";
    });
    var early = earlyStartOk();
    var ok = !!selectedSlot && filled && postcodeArea().status === "ok" && early;
    var btn = document.getElementById("bf-submit");
    if (ok) btn.removeAttribute("disabled"); else btn.setAttribute("disabled", "disabled");
  }

  document.getElementById("booking-form").addEventListener("input", updateSubmitEnabled);
  document.getElementById("booking-form").addEventListener("change", updateSubmitEnabled);

  // ---- "Anything else?" (parking, notes, referral code or reference) ----
  // Closed to start with. Browsers can restore what was typed in it on reload
  // or Back, so it opens if anything is in there, and the customer can see
  // what will be sent. The postcode is looked at again for the same reason,
  // so a restored postcode outside the area shows the WhatsApp offer.
  var extras = document.getElementById("bf-extras");
  function openExtrasIfFilled() {
    if (!extras || extras.open) return;
    var boxes = extras.querySelectorAll('input[type="text"], textarea');
    var filled = !!extras.querySelector('input[type="radio"]:checked') ||
      Array.prototype.some.call(boxes, function (el) { return el.value.trim() !== ""; });
    if (filled) extras.open = true;
  }
  openExtrasIfFilled();
  window.addEventListener("pageshow", function () {
    openExtrasIfFilled();
    renderAreaMsg();
    updateSubmitEnabled();
  });

  // ---- Access on the day (agent page) ----
  // The agent arranging access with us at least 24 hours before (no one named
  // at booking, the default), or a named person on site. Only on pages that ask.
  var accessChoices = document.querySelectorAll('input[name="bf-access"]');
  function accessArrange() {
    var el = document.querySelector('input[name="bf-access"]:checked');
    return !!el && el.value === "arrange";
  }
  function applyAccessChoice() {
    var arrange = accessArrange();
    document.getElementById("bf-site-contact").style.display = arrange ? "none" : "";
    document.getElementById("bf-access-note").style.display = arrange ? "block" : "none";
    ["bf-site-contact-name", "bf-site-contact-phone"].forEach(function (id) {
      document.getElementById(id).required = !arrange;
    });
    updateSubmitEnabled();
  }
  if (accessChoices.length) {
    accessChoices.forEach(function (r) {
      r.addEventListener("change", applyAccessChoice);
    });
    // Browsers can restore the ticked option on reload or Back, so match the
    // fields to whatever is ticked now rather than assuming the default.
    applyAccessChoice();
    window.addEventListener("pageshow", applyAccessChoice);
  }

  // On the first or last page an arrow switches off, which would drop
  // keyboard focus, so it moves to the other arrow instead.
  document.getElementById("bf-days-prev").addEventListener("click", function () {
    dayPage--;
    renderDayPicker();
    if (this.disabled) document.getElementById("bf-days-next").focus();
  });
  document.getElementById("bf-days-next").addEventListener("click", function () {
    dayPage++;
    renderDayPicker();
    if (this.disabled) document.getElementById("bf-days-prev").focus();
  });

  function showConfirmed(reference, payload) {
    confirmedBookingRef = reference;

    // Give a completed booking its own URL (distinct from the #book anchor
    // used to jump to the widget) so Google Analytics can tell "opened the
    // booking form" apart from "actually booked" — GA4's default Enhanced
    // Measurement setting ("Page changes based on browser history events")
    // picks this up as its own pageview automatically, no extra tracking
    // code needed here.
    if (window.history && window.history.pushState) {
      window.history.pushState({}, "", "#booked");
    }

    // Fire an explicit GA4 event for the completed booking itself, on top
    // of the #booked pageview above. This is what actually lets a booking
    // be marked as a GA4 "key event" (conversion) and then traced back to
    // whatever brought that visitor here in the first place (a QR-coded
    // business card, flyer or van graphic, a Google Ad, direct outreach,
    // organic search), rather than only knowing a booking happened at all.
    if (typeof gtag === "function") {
      gtag("event", "booking_complete", {
        value: currentSelection.total,
        currency: "GBP",
        channel: config.channel
      });
    }

    document.getElementById("booking-summary").style.display = "none";
    document.getElementById("booking-form").style.display = "none";
    document.getElementById("booking-need-items").style.display = "none";
    var confirmedEl = document.getElementById("booking-confirmed");
    confirmedEl.style.display = "block";
    confirmedEl.innerHTML =
      "<h3>Booked ✓</h3>" +
      "<p>Thanks " + escapeHtml(payload.name) + ", you're confirmed for <strong>" + escapeHtml(payload.slotLabel) + "</strong>.</p>" +
      '<p>Reference <span class="ref">' + escapeHtml(reference) + "</span>, keep this handy if you need to get in touch.</p>" +
      "<p>A confirmation has been sent to " + escapeHtml(payload.email) + ".</p>";

    // Everything above this (the form, the "you're booking" summary) just
    // disappeared, which shortens the page and can leave the visitor
    // looking at whatever now scrolled up to fill that space — the area
    // below, not the confirmation. Bring it into view explicitly so the
    // reference number is the thing they see immediately.
    confirmedEl.scrollIntoView({ behavior: scrollBehavior(), block: "start" });

    // The Confirm button that had focus has gone too. Moving focus to the
    // confirmation means screen readers read it out, and keyboard users
    // carry on from here rather than the top of the page.
    confirmedEl.setAttribute("tabindex", "-1");
    confirmedEl.focus({ preventScroll: true });

    updateBasketBar();
  }

  function value(id) {
    return document.getElementById(id).value.trim();
  }

  // A random 32-character ID for one press of the book button.
  function newRequestId() {
    var out = "";
    try {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) out += ("0" + bytes[i].toString(16)).slice(-2);
      return out;
    } catch (err) {
      out = "";
      for (var j = 0; j < 32; j++) out += Math.floor(Math.random() * 16).toString(16);
      return out;
    }
  }

  // Waits before the 2 extra tries, in milliseconds.
  var RETRY_WAITS = [2000, 5000];

  // The first time anything other than the postcode is typed in.
  var detailsStarted = false;
  document.getElementById("booking-form").addEventListener("input", function (e) {
    if (detailsStarted || !e.target || e.target.id === "bf-postcode") return;
    detailsStarted = true;
    track("booking_details_started");
  });

  document.getElementById("booking-form").addEventListener("submit", function (e) {
    e.preventDefault();
    track("booking_confirm_pressed", { value: currentSelection.total, currency: "GBP" });
    var statusEl = document.getElementById("bf-status");
    var submitBtn = document.getElementById("bf-submit");
    submitBtn.setAttribute("disabled", "disabled");
    statusEl.style.display = "none";

    var slotMeta = slotsCache.filter(function (s) { return s.start === selectedSlot; })[0];
    var payload = {
      action: "book",
      startTime: selectedSlot,
      slotLabel: slotMeta ? (slotMeta.dayLabel + ", " + slotMeta.timeLabel) : "",
      name: value("bf-name"),
      phone: value("bf-phone"),
      email: value("bf-email"),
      address: value("bf-address") + ", " + value("bf-postcode"),
      postcode: value("bf-postcode"),
      payment: config.payment || document.querySelector('input[name="bf-payment"]:checked').value,
      marketingOptIn: document.getElementById("bf-marketing").checked,
      channel: config.channel,
      items: currentSelection.lines.join(", "),
      // Structured copy of the basket: the backend re-prices from its own
      // reading of the live price list, so the price here can't be tampered with.
      lineItems: Object.keys(state).filter(function (k) { return state[k] > 0; }).map(function (k) { return { item: k, qty: state[k] }; }),
      website: document.getElementById("bf-hp").value, // spam trap (see the hidden field in the form)
      total: formatGBP(currentSelection.total),
      estTime: "~" + formatMins(currentSelection.totalMins)
    };
    Object.keys(config.extraFields || {}).forEach(function (key) {
      payload[key] = value(config.extraFields[key]);
    });
    // Optional on both forms. The booking system adds them to the job's notes.
    var parking = document.querySelector('input[name="bf-parking"]:checked');
    payload.parking = parking ? parking.value : "";
    payload.notes = document.getElementById("bf-notes") ? value("bf-notes") : "";
    var earlyRow = document.getElementById("bf-early-row");
    if (earlyRow) payload.earlyStart = !earlyRow.hidden && document.getElementById("bf-early-start").checked;
    if (accessChoices.length) {
      payload.accessArrange = accessArrange();
      payload.siteContactName = accessArrange() ? "" : value("bf-site-contact-name");
      payload.siteContactPhone = accessArrange() ? "" : value("bf-site-contact-phone");
    }

    // One ID per press of the button. A retry of this same booking sends the
    // same ID, so the booking system never books it twice.
    payload.requestId = newRequestId();
    var body = JSON.stringify(payload);

    function sendBooking() {
      return fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids a CORS preflight
        body: body
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok === false && data.error === "busy") throw new Error("busy");
          return data;
        });
    }

    // Retry only when the request itself failed (no reply, a reply that isn't
    // JSON, or "busy"). Any other answer is final.
    function sendWithRetries(triesLeft) {
      return sendBooking().catch(function (err) {
        var wait = RETRY_WAITS[RETRY_WAITS.length - triesLeft];
        if (wait === undefined) throw err;
        statusEl.textContent = "Still sending your booking...";
        statusEl.className = "bf-status";
        statusEl.style.display = "block";
        announce(statusEl.textContent);
        return new Promise(function (resolve) { setTimeout(resolve, wait); })
          .then(function () { return sendWithRetries(triesLeft - 1); });
      });
    }

    sendWithRetries(RETRY_WAITS.length)
      .then(function (data) {
        if (!data.ok) {
          if (data.error === "out_of_area" || data.error === "bad_postcode") {
            areaTouched = true;
            track("booking_failed", { reason: data.error });
            renderAreaMsg();
            if (data.error === "out_of_area") {
              statusEl.innerHTML = 'We don’t take online bookings in that area yet. <a href="' + waLink(messages.outOfAreaRefused(payload)) + '" target="_blank" rel="noopener">Message us on WhatsApp</a> and we’ll see what we can do.';
            } else {
              statusEl.textContent = "Please check the postcode, it doesn’t look like a full UK postcode.";
            }
            statusEl.className = "bf-status err";
            statusEl.style.display = "block";
            announce(statusEl.textContent);
            updateSubmitEnabled();
            return;
          }
          if (data.error === "slot_taken") {
            track("booking_failed", { reason: "slot_taken" });
            statusEl.textContent = "That time was just taken. Pick another below.";
            statusEl.className = "bf-status err";
            statusEl.style.display = "block";
            announce(statusEl.textContent);
            selectedSlot = null;
            slotsLoaded = false;
            updateBookingSection();
            updateSubmitEnabled(); // stays off until a new time is picked
            return;
          }
          throw new Error(data.error || "unknown");
        }
        showConfirmed(data.reference, payload);
      })
      .catch(function () {
        track("booking_failed", { reason: "error" });
        statusEl.innerHTML = 'Something went wrong on our end. <a href="' + waLink(messages.bookingFailed(payload)) + '" target="_blank" rel="noopener">Send us your details on WhatsApp</a> and we’ll confirm manually.';
        statusEl.className = "bf-status err";
        statusEl.style.display = "block";
        announce(statusEl.textContent);
        updateSubmitEnabled();
      });
  });

  // ---- Google Ads landing anchors ----
  // Lets a specific ad group (carpet / upholstery / mattress / rug / car
  // cleaning) point straight at that category in the price calculator
  // rather than the generic page, so the visitor lands exactly on what the
  // ad promised. A category a page doesn't have is skipped. Categories
  // default to expanded on every page load (no persisted collapse state),
  // so there's nothing to force open here, just a scroll target and a brief
  // highlight to confirm they landed in the right place.
  var AD_SERVICE_ANCHORS = ["carpet-cleaning", "upholstery-cleaning", "mattress-cleaning", "rug-cleaning", "car-interior-cleaning"];
  function highlightServiceAnchor() {
    var id = window.location.hash.replace("#", "");
    if (AD_SERVICE_ANCHORS.indexOf(id) === -1) return;
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.add("ad-highlight");
    el.addEventListener("animationend", function () {
      el.classList.remove("ad-highlight");
    }, { once: true });
  }
  highlightServiceAnchor();

  // ---- Basket bar on phones ----
  // On narrow screens the basket sits below the whole price list. This bar
  // keeps the total and a way on to booking in reach while choosing items.
  // It hides while the basket or the booking form is on screen, and once a
  // booking has gone through. The CSS keeps it off wider screens.
  var basketBar = document.getElementById("basket-bar");
  var onScreen = {};
  function updateBasketBar() {
    if (!basketBar) return;
    var show = currentSelection.total > 0 && !confirmedBookingRef &&
      !onScreen["summary-card"] && !onScreen["book"];
    document.getElementById("basket-bar-total").textContent = formatGBP(currentSelection.total);
    basketBar.hidden = !show;
    document.body.classList.toggle("has-basket-bar", show);
  }
  if (basketBar && "IntersectionObserver" in window) {
    var barWatcher = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { onScreen[entry.target.id] = entry.isIntersecting; });
      updateBasketBar();
    });
    barWatcher.observe(document.getElementById("summary-card"));
    barWatcher.observe(document.getElementById("book"));
  } else {
    basketBar = null; // can't tell when it would be in the way, so leave it off
  }

  render();
};
