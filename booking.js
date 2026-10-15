(function () {
  "use strict";
  function init(options) {
    var store = options.store, auth = options.auth, model = options.model, config = options.config;
    var el = {}, drafts = new Map(), draft = null, weekOffset = 0;
    ["addCourtButton", "courtDialog", "courtForm", "courtFields", "courtBooker", "courtDate", "courtTime", "courtNumber",
      "courtCode", "courtQuickDates", "thisWeekButton", "nextWeekButton", "courtStatus", "courtError", "saveCourtButton", "closeCourtButton"].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
    for (var hour = config.booking.firstStartHour; hour <= config.booking.lastStartHour; hour += 1) {
      var time = String(hour).padStart(2, "0") + ":00";
      el.courtTime.add(new Option((hour % 12 || 12) + ":00" + (hour < 12 ? "am" : "pm"), time));
    }
    for (var number = config.booking.firstCourtNumber; number <= config.booking.lastCourtNumber; number += 1) {
      el.courtNumber.add(new Option("Court " + number, String(number)));
    }
    function clock() { return model.londonClock(new Date().toISOString()); }
    function dateObject(key) { return new Date(key + "T12:00:00Z"); }
    function shiftDate(key, days) { var value = dateObject(key); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
    function capture() {
      if (!draft) return;
      draft.values = { date: el.courtDate.value, time: el.courtTime.value, courtNumber: el.courtNumber.value, code: el.courtCode.value };
    }
    function intent() {
      return { type: "court.add", court: { id: draft.id, date: draft.values.date, time: draft.values.time,
        courtNumber: Number(draft.values.courtNumber), code: draft.values.code, bookedBy: draft.userId } };
    }
    function isThisAction(action) { return draft && action && action.type === "court.add" && action.court.id === draft.id; }
    function renderDates() {
      var today = clock().date;
      el.courtDate.min = today;
      var weekday = dateObject(today).getUTCDay();
      var monday = shiftDate(today, -((weekday + 6) % 7) + weekOffset * 7);
      el.thisWeekButton.setAttribute("aria-pressed", String(weekOffset === 0));
      el.nextWeekButton.setAttribute("aria-pressed", String(weekOffset === 1));
      el.courtQuickDates.replaceChildren();
      for (var index = 0; index < 7; index += 1) {
        (function (key) {
          var button = document.createElement("button");
          button.type = "button"; button.className = "button secondary date-button";
          button.textContent = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(dateObject(key));
          button.setAttribute("aria-label", new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "full" }).format(dateObject(key)));
          button.setAttribute("aria-pressed", String(el.courtDate.value === key));
          button.disabled = key < today;
          button.addEventListener("click", function () { el.courtDate.value = key; capture(); renderDates(); });
          el.courtQuickDates.appendChild(button);
        })(shiftDate(monday, index));
      }
    }
    function showBooker(data) {
      var user = data && data.users.users.find(function (item) { return draft && item.id === draft.userId; });
      el.courtBooker.value = user ? user.name : (draft ? draft.userId : "");
    }
    function open() {
      if (!auth.requireWrite()) return;
      var actor = auth.getSession();
      draft = drafts.get(actor.userId);
      if (!draft) {
        draft = { id: "court-" + window.crypto.randomUUID(), userId: actor.userId,
          values: { date: "", time: config.booking.defaultTime, courtNumber: "", code: "" }, pending: false, submitted: false };
        drafts.set(actor.userId, draft);
      }
      el.courtDate.value = draft.values.date;
      el.courtTime.value = draft.values.time;
      el.courtNumber.value = draft.values.courtNumber;
      el.courtCode.value = draft.values.code;
      showBooker(store.getSnapshot());
      weekOffset = dateObject(clock().date).getUTCDay() === 0 ? 1 : 0;
      renderDates();
      renderDraft();
      if (!el.courtDialog.open) el.courtDialog.showModal();
    }
    function renderDraft() {
      if (!draft) return;
      var recovery = store.getRecovery();
      var recovering = recovery && isThisAction(recovery.action);
      var uncertain = recovering && recovery.outcome === "uncertain";
      el.courtFields.disabled = draft.pending || uncertain;
      el.saveCourtButton.disabled = draft.pending;
      el.courtForm.setAttribute("aria-busy", String(draft.pending));
      el.saveCourtButton.textContent = draft.pending ? "Saving…" : recovering ? "Retry save" : "Save court";
      el.courtStatus.textContent = draft.pending ? "Saving your court…" : "";
      el.courtError.textContent = uncertain ? "Save not confirmed. Retry the same booking before changing its details. " + (draft.error || "") :
        draft.error || (recovering ? "Court not saved. Your details are kept; check them or retry." : "");
    }
    async function submit(event) {
      event.preventDefault();
      if (!draft || draft.pending || !auth.requireWrite()) return;
      var actor = auth.getSession();
      if (actor.userId !== draft.userId) return;
      el.courtCode.value = el.courtCode.value.trim().replace(/^\*+/, "");
      capture();
      var recovery = store.getRecovery();
      var retrying = recovery && isThisAction(recovery.action) && JSON.stringify(recovery.action) === JSON.stringify(intent());
      // An uncertain booking must be reconciled even if its start time has passed.
      if (!retrying) {
        if (!el.courtForm.reportValidity()) return;
        var today = clock();
        if (draft.values.date < today.date || (draft.values.date === today.date && Number(draft.values.time.slice(0, 2)) * 60 <= today.minutes)) {
          draft.error = "Choose a start time in the future (Europe/London).";
          renderDraft(); el.courtDate.focus(); return;
        }
      }
      draft.pending = true; draft.submitted = true; draft.error = ""; renderDraft();
      var submitting = draft;
      try {
        if (retrying) await store.retry(); else await store.mutate(intent());
        drafts.delete(submitting.userId);
      } catch (error) {
        submitting.pending = false; submitting.error = error.message;
        if (error.outcome === "saved") drafts.delete(submitting.userId);
        if (draft === submitting) renderDraft();
      }
    }
    el.addCourtButton.addEventListener("click", open);
    el.closeCourtButton.addEventListener("click", function () { capture(); el.courtDialog.close(); });
    el.courtDialog.addEventListener("cancel", capture);
    el.courtForm.addEventListener("submit", submit);
    el.courtForm.addEventListener("input", function () {
      if (el.courtCode === document.activeElement) el.courtCode.value = el.courtCode.value.trim().replace(/^\*+/, "");
      capture(); if (draft) draft.error = "";
    });
    el.courtDate.addEventListener("change", function () { capture(); renderDates(); });
    el.thisWeekButton.addEventListener("click", function () { weekOffset = 0; renderDates(); });
    el.nextWeekButton.addEventListener("click", function () { weekOffset = 1; renderDates(); });
    window.addEventListener("early-birds-session-change", function () {
      var actor = auth.getSession();
      if (draft && (!actor || actor.userId !== draft.userId)) {
        capture(); el.courtDialog.close(); draft = null; el.courtForm.reset();
      }
    });
    store.subscribe(function (event) {
      el.addCourtButton.disabled = event.status.phase === "saving";
      if (!draft) return;
      var recovery = store.getRecovery();
      if (recovery && isThisAction(recovery.action)) {
        draft.pending = event.status.save.outcome === "pending";
        if (!draft.pending && event.status.phase === "error") draft.error = event.status.message;
      }
      var saved = draft.submitted && event.status.save.outcome === "saved" && event.data &&
        event.data.state.courts.some(function (court) { return court.id === draft.id; });
      if (saved) {
        drafts.delete(draft.userId); draft = null;
        el.courtDialog.close(); el.courtForm.reset(); el.addCourtButton.focus();
      } else { showBooker(event.data); renderDraft(); }
    });
  }
  window.EarlyBirdsBooking = Object.freeze({ init: init });
})();
