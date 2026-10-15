(function () {
  "use strict";
  function init(options) {
    var store = options.store, auth = options.auth, model = options.model, config = options.config;
    var el = {}, drafts = new Map(), draft = null, weekOffset = 0;
    ["addCourtButton", "courtDialog", "courtForm", "courtFields", "courtBooker", "courtDate", "courtTime", "courtNumber",
      "courtCode", "courtQuickDates", "thisWeekButton", "nextWeekButton", "courtStatus", "courtError", "saveCourtButton", "closeCourtButton",
      "courtTitle", "courtDescription", "courtBookerSelect", "reloadCourtButton"].forEach(function (id) {
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
      if (draft.mode === "edit") draft.values.bookedBy = el.courtBookerSelect.value;
    }
    function intent() {
      if (draft.mode === "delete") return { type: "court.remove", courtId: draft.id, expected: draft.original };
      if (draft.mode === "edit") {
        var changes = {}, expected = {};
        Object.keys(draft.original).forEach(function (key) {
          var value = key === "courtNumber" ? Number(draft.values[key]) : draft.values[key];
          if (value !== draft.original[key]) { changes[key] = value; expected[key] = draft.original[key]; }
        });
        return { type: "court.patch", courtId: draft.id, expected: expected, changes: changes };
      }
      return { type: "court.add", court: { id: draft.id, date: draft.values.date, time: draft.values.time,
        courtNumber: Number(draft.values.courtNumber), code: draft.values.code, bookedBy: draft.userId } };
    }
    function isThisAction(action) {
      return draft && action && (draft.mode === "add" ? action.type === "court.add" && action.court.id === draft.id :
        action.courtId === draft.id && action.type === (draft.mode === "edit" ? "court.patch" : "court.remove"));
    }
    function details(court) {
      return { date: court.date, time: court.time, courtNumber: court.courtNumber, code: court.code, bookedBy: court.bookedBy };
    }
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
      var id = draft && (draft.mode === "add" ? draft.userId : draft.values.bookedBy);
      var users = data ? data.users.users : [];
      var user = users.find(function (item) { return item.id === id; });
      el.courtBooker.value = user ? user.name : (id || "");
      var editable = draft && draft.fromAdmin && draft.mode === "edit" && auth.getSession() && auth.getSession().isAdmin;
      el.courtBooker.hidden = Boolean(editable);
      el.courtBookerSelect.hidden = !editable;
      el.courtBooker.previousElementSibling.htmlFor = editable ? "courtBookerSelect" : "courtBooker";
      el.courtBookerSelect.replaceChildren();
      users.filter(function (item) { return item.active || item.id === id; }).forEach(function (item) {
        var option = new Option(item.name + (item.active ? "" : " (inactive)"), item.id);
        option.disabled = !item.active; el.courtBookerSelect.add(option);
      });
      el.courtBookerSelect.value = id || "";
    }
    function open(mode, courtId, fromAdmin) {
      if (!auth.requireWrite(fromAdmin ? { admin: true } : undefined)) return;
      var actor = auth.getSession();
      var recovery = store.getRecovery();
      if (recovery && (recovery.outcome === "pending" || recovery.outcome === "uncertain")) return;
      mode = mode || "add";
      var data = store.getSnapshot();
      var court = data && data.state.courts.find(function (item) { return item.id === courtId; });
      if (mode !== "add" && (!court || (!fromAdmin && court.bookedBy !== actor.userId))) return;
      var key = actor.userId + ":" + actor.isAdmin + ":" + Boolean(fromAdmin) + ":" + mode + ":" + (courtId || "");
      draft = drafts.get(key);
      if (!draft) {
        draft = { id: courtId || "court-" + window.crypto.randomUUID(), userId: actor.userId, isAdmin: actor.isAdmin, fromAdmin: Boolean(fromAdmin), mode: mode, key: key,
          original: court ? details(court) : null,
          values: court ? details(court) : { date: "", time: config.booking.defaultTime, courtNumber: "", code: "" }, pending: false, submitted: false };
        drafts.set(key, draft);
      }
      displayDraft();
    }
    function displayDraft() {
      el.courtDate.value = draft.values.date;
      el.courtTime.value = draft.values.time;
      el.courtNumber.value = draft.values.courtNumber;
      el.courtCode.value = draft.values.code;
      el.courtTitle.textContent = draft.mode === "delete" ? "Delete court?" : draft.mode === "edit" ? "Edit court" : "Add Court";
      el.courtDescription.textContent = draft.mode === "delete" ? "Delete Court " + draft.original.courtNumber + " on " + draft.original.date + " at " + draft.original.time + "? Its playing and reserve lists will be removed. Recorded bagels will be kept." :
        draft.mode === "edit" ? "Update this booking. " + (draft.fromAdmin ? "Changing the booker does not change who is playing. " : "") + "Load latest details replaces your unsaved edits." :
          "Add a court you have booked. You will automatically join as a player.";
      el.courtFields.hidden = draft.mode === "delete";
      el.courtForm.noValidate = draft.mode === "delete";
      showBooker(store.getSnapshot());
      weekOffset = dateObject(clock().date).getUTCDay() === 0 ? 1 : 0;
      renderDates();
      renderDraft();
      if (!el.courtDialog.open) el.courtDialog.showModal();
    }
    function renderDraft() {
      if (!draft) return;
      var recovery = store.getRecovery();
      var recovering = recovery && isThisAction(recovery.action) && JSON.stringify(recovery.action) === JSON.stringify(intent());
      var uncertain = recovering && recovery.outcome === "uncertain";
      el.courtFields.disabled = draft.pending || uncertain;
      el.saveCourtButton.disabled = draft.pending;
      el.courtForm.setAttribute("aria-busy", String(draft.pending));
      el.saveCourtButton.textContent = draft.pending ? "Saving…" : recovering ? "Retry save" : draft.mode === "delete" ? "Delete court" : "Save court";
      el.reloadCourtButton.hidden = draft.mode === "add" || !draft.error || uncertain;
      el.reloadCourtButton.disabled = draft.pending;
      el.courtStatus.textContent = draft.pending ? "Saving your court…" : "";
      el.courtError.textContent = uncertain ? "Save not confirmed. Retry the same booking before changing its details. " + (draft.error || "") :
        draft.error || (recovering ? "Court not saved. Your details are kept; check them or retry." : "");
    }
    async function submit(event) {
      event.preventDefault();
      if (!draft || draft.pending || !auth.requireWrite()) return;
      var actor = auth.getSession();
      if (actor.userId !== draft.userId || actor.isAdmin !== draft.isAdmin) return;
      el.courtCode.value = el.courtCode.value.trim().replace(/^\*+/, "");
      capture();
      var recovery = store.getRecovery();
      var retrying = recovery && isThisAction(recovery.action) && JSON.stringify(recovery.action) === JSON.stringify(intent());
      // An uncertain booking must be reconciled even if its start time has passed.
      if (!retrying) {
        if (draft.mode !== "delete" && !el.courtForm.reportValidity()) return;
        var today = clock();
        if (draft.mode !== "delete" && (draft.values.date < today.date || (draft.values.date === today.date && Number(draft.values.time.slice(0, 2)) * 60 <= today.minutes))) {
          draft.error = "Choose a start time in the future (Europe/London).";
          renderDraft(); el.courtDate.focus(); return;
        }
      }
      draft.pending = true; draft.submitted = true; draft.error = ""; renderDraft();
      var submitting = draft;
      submitting.action = retrying ? recovery.action : intent();
      try {
        if (retrying) await store.retry(); else await store.mutate(submitting.action);
        drafts.delete(submitting.key);
      } catch (error) {
        submitting.pending = false; submitting.error = error.message;
        if (error.outcome === "saved") drafts.delete(submitting.key);
        if (draft === submitting) renderDraft();
      }
    }
    el.addCourtButton.addEventListener("click", function () { open("add"); });
    ["gamesList", "adminCourtsList"].forEach(function (id) {
      document.getElementById(id).addEventListener("click", function (event) {
        var button = event.target.closest("[data-court-management]");
        if (button && !button.disabled) open(button.dataset.courtManagement, button.closest(".game-card").dataset.courtId, id === "adminCourtsList");
      });
    });
    el.reloadCourtButton.addEventListener("click", async function () {
      if (!draft || draft.pending) return;
      var currentDraft = draft;
      currentDraft.pending = true; renderDraft();
      try {
        var data = await store.refresh();
        if (draft !== currentDraft) return;
        var court = data.state.courts.find(function (item) { return item.id === draft.id; });
        if (!court) throw new Error("This court no longer exists. Close this dialog to see the latest games.");
        draft.original = details(court); draft.values = details(court); draft.error = ""; draft.submitted = false;
        displayDraft();
      } catch (error) { currentDraft.error = error.message; }
      finally { currentDraft.pending = false; if (draft === currentDraft) renderDraft(); }
    });
    el.closeCourtButton.addEventListener("click", function () { capture(); el.courtDialog.close(); });
    el.courtDialog.addEventListener("cancel", capture);
    el.courtForm.addEventListener("submit", submit);
    el.courtForm.addEventListener("input", function () {
      if (el.courtCode === document.activeElement) el.courtCode.value = el.courtCode.value.trim().replace(/^\*+/, "");
      capture(); if (draft) { draft.error = ""; renderDraft(); }
    });
    el.courtDate.addEventListener("change", function () { capture(); renderDates(); });
    el.thisWeekButton.addEventListener("click", function () { weekOffset = 0; renderDates(); });
    el.nextWeekButton.addEventListener("click", function () { weekOffset = 1; renderDates(); });
    window.addEventListener("early-birds-session-change", function () {
      var actor = auth.getSession();
      if (draft && (!actor || actor.userId !== draft.userId || actor.isAdmin !== draft.isAdmin)) {
        capture(); el.courtDialog.close(); draft = null; el.courtForm.reset();
      }
    });
    store.subscribe(function (event) {
      var pendingRecovery = store.getRecovery();
      el.addCourtButton.disabled = event.status.phase === "saving" || Boolean(pendingRecovery && pendingRecovery.outcome === "uncertain");
      if (!draft) return;
      var recovery = store.getRecovery();
      if (recovery && isThisAction(recovery.action)) {
        if (event.status.phase === "saving" || event.status.phase === "error") draft.pending = event.status.save.outcome === "pending";
        if (!draft.pending && event.status.phase === "error") draft.error = event.status.message;
      }
      var savedCourt = event.data && event.data.state.courts.find(function (court) { return court.id === draft.id; });
      var saved = draft.submitted && draft.action && event.status.save.outcome === "saved" && event.data &&
        (draft.mode === "delete" ? !savedCourt : savedCourt && Object.keys(draft.mode === "edit" ? draft.action.changes : draft.action.court).every(function (key) {
          return savedCourt[key] === (draft.mode === "edit" ? draft.action.changes[key] : draft.action.court[key]);
        }));
      if (saved) {
        var fromAdmin = draft.fromAdmin;
        drafts.delete(draft.key); draft = null;
        el.courtDialog.close(); el.courtForm.reset();
        var target = fromAdmin ? document.querySelector("#adminCourtsList [data-court-management]") || document.getElementById("adminTabButton") : el.addCourtButton;
        target.focus();
      } else { showBooker(event.data); renderDraft(); }
    });
  }
  window.EarlyBirdsBooking = Object.freeze({ init: init });
})();
