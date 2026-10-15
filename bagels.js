(function () {
  "use strict";
  function init(options) {
    var auth = options.auth, store = options.store, model = options.model;
    var el = {}, drafts = new Map(), draft = null, latest = null, saving = false;
    ["bagelDialog", "bagelForm", "bagelContext", "bagelEligibility", "bagelFields", "bagelDateFields", "bagelDate", "bagelFormat",
      "bagelWinner1", "bagelWinner2", "bagelLoser1", "bagelLoser2", "bagelWinner2Row", "bagelLoser2Row", "bagelPlayersHelp",
      "existingBagels", "existingBagelsList", "bagelStatus", "bagelError", "saveBagelButton", "anotherBagelButton", "refreshBagelButton", "closeBagelButton"].forEach(function (id) { el[id] = document.getElementById(id); });
    var playerFields = ["bagelWinner1", "bagelWinner2", "bagelLoser1", "bagelLoser2"];
    function today() { return model.londonClock(new Date().toISOString()).date; }
    function source() { return latest && draft && latest.state.courts.find(function (court) { return court.id === draft.courtId; }); }
    function eligible() {
      var court = source();
      return draft && (!draft.courtId || court) && model.canReportBagel(court, auth.getSession(), new Date().toISOString(), draft.fromAdmin);
    }
    function records() {
      if (!latest || !draft) return [];
      return latest.state.bagels.filter(function (bagel) { return draft.courtId ? bagel.sourceCourtId === draft.courtId : bagel.sourceCourtId === null && bagel.date === draft.values.date; });
    }
    function capture() {
      if (!draft) return;
      draft.values.date = el.bagelDate.value; draft.values.format = el.bagelFormat.value;
      playerFields.forEach(function (id) { draft.values[id] = el[id].value; });
    }
    function intent() {
      var doubles = draft.values.format === "doubles";
      return { type: "bagel.add", asPlayer: !draft.fromAdmin, bagel: { id: draft.id, sourceCourtId: draft.courtId || null, date: draft.values.date,
        winnerIds: doubles ? [draft.values.bagelWinner1, draft.values.bagelWinner2] : [draft.values.bagelWinner1],
        loserIds: doubles ? [draft.values.bagelLoser1, draft.values.bagelLoser2] : [draft.values.bagelLoser1] } };
    }
    function recoveryFor(value) {
      var recovery = store.getRecovery();
      return recovery && recovery.action.type === "bagel.add" && recovery.action.bagel.id === value.id ? recovery : null;
    }
    function newSet(value, armed) {
      value.id = "bagel-" + window.crypto.randomUUID(); value.armed = armed; value.completed = false; value.submitted = false;
      value.pending = false; value.error = ""; value.action = null;
      value.values = { date: value.values.date, format: "singles", bagelWinner1: "", bagelWinner2: "", bagelLoser1: "", bagelLoser2: "" };
    }
    function render() {
      if (!draft || !latest) return;
      var court = source(), allowed = eligible(), recovery = recoveryFor(draft);
      var uncertain = recovery && recovery.outcome === "uncertain";
      if (court && !draft.pending && !uncertain && !draft.completed) draft.values.date = court.date;
      var entries = records();
      if (draft.armed === null && draft.checked && !draft.checking && !draft.readError) draft.armed = entries.length === 0;
      el.bagelContext.textContent = court ? "Court " + court.courtNumber + ", " + court.date + " at " + court.time :
        draft.courtId ? "This game is no longer available." : "Historical entry for a past or current London date, with two or four distinct players.";
      el.bagelEligibility.textContent = draft.checking ? "Checking the latest game and player details…" : draft.readError ||
        (allowed ? "Eligible for a singles or doubles 6–0 set." : "This game is no longer eligible. Players must be green and report after the game ends on the same London day. Admin can use historical entry.");
      el.existingBagels.hidden = entries.length === 0; el.existingBagelsList.replaceChildren();
      entries.forEach(function (bagel) {
        var item = document.createElement("li");
        item.textContent = bagel.date + ": " + bagel.winners.map(function (player) { return player.name; }).join(" & ") + " beat " + bagel.losers.map(function (player) { return player.name; }).join(" & ") + " 6–0";
        el.existingBagelsList.appendChild(item);
      });
      var values = draft.values, doubles = values.format === "doubles";
      el.bagelDate.value = values.date; el.bagelDate.max = today(); el.bagelDate.readOnly = Boolean(draft.courtId);
      el.bagelFormat.value = values.format;
      el.bagelWinner2Row.hidden = !doubles; el.bagelLoser2Row.hidden = !doubles;
      el.bagelWinner2.required = doubles; el.bagelLoser2.required = doubles;
      el.bagelWinner2.disabled = !doubles; el.bagelLoser2.disabled = !doubles;
      var users = latest.users.users.filter(function (user) { return draft.fromAdmin || (court && court.green.indexOf(user.id) >= 0); });
      playerFields.forEach(function (id) {
        el[id].replaceChildren(new Option("Choose player", ""));
        users.forEach(function (user) { el[id].add(new Option(user.name + (user.active ? "" : " (inactive)"), user.id)); });
        var selected = values[id];
        if (selected && !users.some(function (user) { return user.id === selected; })) {
          var removed = new Option("Player no longer eligible", selected); removed.disabled = true; el[id].add(removed);
        }
        el[id].value = selected;
      });
      el.bagelPlayersHelp.textContent = draft.fromAdmin ? "Choose distinct registered players, including inactive players for historical results." :
        "Choose distinct players from this game's green list. Singles can use any two, including players who carried on after doubles.";
      var blocked = draft.pending || saving || draft.checking || Boolean(draft.readError) || Boolean(uncertain);
      el.bagelFields.hidden = !draft.armed || draft.completed;
      el.bagelFields.disabled = blocked || !allowed || !draft.armed || draft.completed;
      el.bagelDateFields.disabled = blocked || !allowed || draft.completed;
      el.saveBagelButton.hidden = !draft.armed || draft.completed;
      el.saveBagelButton.disabled = draft.pending || saving || draft.checking || Boolean(draft.readError) || (!uncertain && !allowed);
      el.saveBagelButton.textContent = draft.pending ? "Saving…" : recovery ? "Retry save" : "Save 6–0 set";
      el.anotherBagelButton.hidden = !entries.length && !draft.completed;
      el.anotherBagelButton.disabled = blocked || !allowed || Boolean(recovery);
      el.refreshBagelButton.disabled = draft.pending || saving || draft.checking || Boolean(uncertain);
      el.bagelForm.setAttribute("aria-busy", String(draft.pending || draft.checking));
      el.bagelStatus.textContent = draft.pending ? "Saving your 6–0 set…" : draft.completed ? "Bagel saved. Choose Record another 6–0 set only for a separate set." : "";
      el.bagelError.textContent = uncertain ? "Save not confirmed. Retry the same set before changing its details. " + (draft.error || "") : draft.error || "";
    }
    async function refresh() {
      if (!draft || draft.pending || draft.checking) return;
      var value = draft; value.checking = true; value.readError = ""; render();
      try { latest = await store.refresh(); value.checked = true; }
      catch (_) { value.readError = "Could not check eligibility against shared data. Refresh game and try again."; }
      finally { value.checking = false; if (draft === value) render(); }
    }
    document.addEventListener("click", function (event) {
      var button = event.target.closest("[data-bagel-court]");
      if (!button || button.disabled) return;
      var fromAdmin = button.dataset.bagelAdmin === "true";
      if (!auth.requireWrite(fromAdmin ? { admin: true } : undefined)) return;
      var actor = auth.getSession(), courtId = button.dataset.bagelCourt;
      var key = actor.userId + ":" + actor.isAdmin + ":" + fromAdmin + ":" + courtId;
      var value = drafts.get(key), recovery = store.getRecovery();
      if (saving || (recovery && recovery.outcome === "uncertain" && (!value || !recoveryFor(value)))) return;
      latest = store.getSnapshot();
      if (!value) {
        var court = latest && latest.state.courts.find(function (item) { return item.id === courtId; });
        value = { key: key, userId: actor.userId, isAdmin: actor.isAdmin, fromAdmin: fromAdmin, courtId: courtId, values: { date: court ? court.date : today() } };
        newSet(value, null); drafts.set(key, value);
      }
      draft = value; render();
      if (!el.bagelDialog.open) el.bagelDialog.showModal();
      if (!recoveryFor(draft) || recoveryFor(draft).outcome !== "uncertain") refresh();
    });
    el.bagelForm.addEventListener("input", function () { capture(); if (draft) draft.error = ""; });
    el.bagelFormat.addEventListener("change", function () { capture(); render(); });
    el.bagelDate.addEventListener("change", function () {
      capture(); if (draft && !draft.submitted) draft.armed = records().length === 0; render();
    });
    el.anotherBagelButton.addEventListener("click", function () {
      if (!draft || el.anotherBagelButton.disabled) return;
      newSet(draft, true); render(); el.bagelFormat.focus();
    });
    el.refreshBagelButton.addEventListener("click", refresh);
    el.closeBagelButton.addEventListener("click", function () { capture(); el.bagelDialog.close(); });
    el.bagelDialog.addEventListener("cancel", capture);
    el.bagelDialog.addEventListener("close", function () {
      if (el.bagelDialog.open) return;
      var value = draft; draft = null;
      if (!value) return;
      var target = Array.from(document.querySelectorAll("[data-bagel-court]")).find(function (button) { return button.dataset.bagelCourt === value.courtId && button.dataset.bagelAdmin === String(value.fromAdmin) && !button.hidden; });
      (target || document.getElementById(value.fromAdmin ? "adminTabButton" : "gamesTabButton")).focus({ preventScroll: true });
    });
    el.bagelForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!draft || draft.pending || saving || draft.checking || draft.readError || !draft.armed || draft.completed) return;
      if (!auth.requireWrite(draft.fromAdmin ? { admin: true } : undefined)) return;
      capture();
      var value = draft, recovery = recoveryFor(value), action = intent();
      var retrying = recovery && JSON.stringify(recovery.action) === JSON.stringify(action);
      if (!retrying) {
        if (!eligible()) { value.error = "This game is no longer eligible. Refresh game to review it."; render(); return; }
        if (!el.bagelForm.reportValidity()) return;
        var ids = action.bagel.winnerIds.concat(action.bagel.loserIds);
        if (new Set(ids).size !== ids.length) { value.error = "Choose a different player for each position."; render(); return; }
      }
      value.pending = true; value.submitted = true; value.error = ""; value.action = action; render();
      try { if (retrying) await store.retry(); else await store.mutate(action); }
      catch (error) { value.error = error.message; }
      finally { value.pending = false; if (draft === value) render(); }
    });
    window.addEventListener("early-birds-session-change", function () { capture(); el.bagelDialog.close(); draft = null; });
    store.subscribe(function (event) {
      saving = event.status.phase === "saving";
      if (event.data) latest = event.data;
      drafts.forEach(function (value) {
        if (value.submitted && event.status.save.outcome === "saved" && event.data && event.data.state.bagels.some(function (bagel) { return bagel.id === value.id; })) {
          value.completed = true; value.pending = false; value.error = "";
        }
        if (recoveryFor(value) && event.status.phase === "error") { value.pending = false; value.error = event.status.message; }
      });
      render();
    });
    function node(tag, className, text) {
      var value = document.createElement(tag);
      if (className) value.className = className;
      if (text !== undefined) value.textContent = text;
      return value;
    }
    function icon(text, className) {
      var value = node("span", className, text); value.setAttribute("aria-hidden", "true"); return value;
    }
    function renderList(data) {
      var list = document.getElementById("bagelsList");
      var entries = data.state.bagels.slice().sort(function (a, b) {
        return b.date.localeCompare(a.date) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
      });
      list.replaceChildren();
      entries.forEach(function (bagel, index) {
        var card = node("li", "bagel-card"); card.dataset.bagelId = bagel.id;
        var header = node("div", "bagel-card-heading");
        var heading = node("h3", "bagel-date"); heading.id = "bagel-result-" + index;
        card.setAttribute("aria-labelledby", heading.id);
        var parts = {};
        new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" })
          .formatToParts(new Date(bagel.date + "T12:00:00Z")).forEach(function (part) { parts[part.type] = part.value; });
        var date = node("time", "", parts.weekday + " " + parts.day + " " + parts.month + " " + parts.year); date.dateTime = bagel.date;
        heading.appendChild(date);
        var details = node("div", "bagel-result-details");
        details.append(heading, node("p", "bagel-score", "6–0 · " + (bagel.winners.length === 1 ? "Singles" : "Doubles")));
        header.append(icon("🥯", "bagel-icon"), details);
        var teams = node("div", "bagel-teams");
        [["Winners", "🙂", bagel.winners, "bagel-winners"], ["Losers", "🙁", bagel.losers, "bagel-losers"]].forEach(function (team) {
          var group = node("section", "bagel-team-result " + team[3]); group.setAttribute("aria-label", team[0]);
          var label = node("h4", "bagel-team-label"); label.append(icon(team[1], "bagel-face"), document.createTextNode(" " + team[0]));
          var players = node("ul", "player-list");
          team[2].forEach(function (player) { players.appendChild(node("li", "player-chip", player.name)); });
          group.append(label, players); teams.appendChild(group);
        });
        card.append(header, teams); list.appendChild(card);
      });
      options.ui.setPanelState("bagels", entries.length ? "ready" : "empty");
    }
    return Object.freeze({ update: function (data) { latest = data; render(); }, renderList: renderList });
  }
  window.EarlyBirdsBagels = Object.freeze({ init: init });
})();
