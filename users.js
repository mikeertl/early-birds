(function () {
  "use strict";
  function init(options) {
    var auth = options.auth, store = options.store;
    var el = {}, latest = null, draft = null, drafts = new Map(), saving = false;
    ["adminPlayersList", "adminPlayersEmpty", "addPlayerButton", "playerDialog", "playerForm", "playerTitle", "playerDescription", "playerFields",
      "playerName", "playerActive", "playerStatus", "playerError", "savePlayerButton", "reloadPlayerButton", "closePlayerButton"].forEach(function (id) { el[id] = document.getElementById(id); });
    function capture() { if (draft) draft.values = { name: el.playerName.value, active: el.playerActive.checked }; }
    function intent() {
      if (draft.mode === "add") return { type: "user.add", user: { id: draft.id, name: draft.values.name, active: draft.values.active } };
      var changes = {}, expected = {};
      ["name", "active"].forEach(function (key) { if (draft.values[key] !== draft.original[key]) { changes[key] = draft.values[key]; expected[key] = draft.original[key]; } });
      return { type: "user.patch", userId: draft.id, changes: changes, expected: expected };
    }
    function matches(action, value) { return action && (value.mode === "add" ? action.type === "user.add" && action.user.id === value.id : action.type === "user.patch" && action.userId === value.id); }
    function locked() { var recovery = store.getRecovery(); return saving || Boolean(recovery && recovery.outcome === "uncertain"); }
    function showDraft() {
      if (!draft) return;
      el.playerName.value = draft.values.name; el.playerActive.checked = draft.values.active;
      el.playerName.readOnly = draft.mode === "toggle";
      renderDraft(); if (!el.playerDialog.open) el.playerDialog.showModal();
    }
    function renderDraft() {
      if (!draft) return;
      var recovery = store.getRecovery();
      var retrying = recovery && matches(recovery.action, draft) && JSON.stringify(recovery.action) === JSON.stringify(intent());
      var uncertain = retrying && recovery.outcome === "uncertain";
      var pending = draft.pending || draft.loading || saving;
      el.playerTitle.textContent = draft.mode === "add" ? "Add player" : draft.mode === "toggle" ? (draft.values.active ? "Reactivate player" : "Deactivate player") : "Edit player";
      el.playerDescription.textContent = !draft.values.active && draft.id === draft.actorId ?
        "Deactivating your own player will sign you out. Another active player can choose Admin mode to reactivate you. Existing bookings and bagel history are kept." :
        "Inactive players cannot sign in or be selected for new bookings. Existing bookings and recorded bagel names are kept. Load latest details replaces unsaved changes.";
      el.playerFields.disabled = pending || uncertain;
      el.savePlayerButton.disabled = pending;
      el.savePlayerButton.textContent = draft.pending ? "Saving…" : retrying ? "Retry save" : draft.mode === "toggle" ? (draft.values.active ? "Reactivate player" : "Deactivate player") : "Save player";
      el.reloadPlayerButton.hidden = draft.mode === "add" || !draft.error || uncertain;
      el.reloadPlayerButton.disabled = pending;
      el.playerForm.setAttribute("aria-busy", String(pending));
      el.playerStatus.textContent = draft.pending ? "Saving player…" : draft.loading ? "Loading latest player details…" : "";
      el.playerError.textContent = uncertain ? "Save not confirmed. Retry the same change before editing. " + (draft.error || "") : draft.error || "";
    }
    function open(mode, id) {
      if (!auth.requireWrite({ admin: true }) || locked()) return;
      var actor = auth.getSession(); latest = store.getSnapshot();
      var user = latest && latest.users.users.find(function (item) { return item.id === id; });
      if (mode !== "add" && !user) return;
      var key = actor.userId + ":" + mode + ":" + (id || "");
      draft = drafts.get(key);
      if (!draft) {
        draft = { key: key, actorId: actor.userId, mode: mode, id: id || "player-" + window.crypto.randomUUID(),
          original: user ? { name: user.name, active: user.active } : null,
          values: user ? { name: user.name, active: mode === "toggle" ? !user.active : user.active } : { name: "", active: true } };
        drafts.set(key, draft);
      }
      showDraft();
    }
    function render(data) {
      if (data) latest = data;
      var actor = auth.getSession(), allowed = Boolean(actor && actor.isAdmin);
      var focused = document.activeElement;
      var previous = focused && focused.dataset.playerAction ? { id: focused.dataset.playerId, action: focused.dataset.playerAction } : null;
      el.addPlayerButton.hidden = !allowed; el.addPlayerButton.disabled = locked();
      el.adminPlayersList.replaceChildren();
      var users = allowed && latest ? latest.users.users.slice().sort(function (a, b) { return Number(b.active) - Number(a.active) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id); }) : [];
      el.adminPlayersEmpty.hidden = !allowed || users.length > 0;
      users.forEach(function (user) {
        var item = document.createElement("li"); item.className = "admin-player"; item.dataset.playerId = user.id;
        var details = document.createElement("div"); details.className = "admin-player-details";
        var name = document.createElement("span"); name.className = "admin-player-name"; name.textContent = user.name;
        var state = document.createElement("span"); state.className = "admin-player-state"; state.textContent = user.active ? "Active" : "Inactive";
        details.append(name, state);
        var actions = document.createElement("div"); actions.className = "admin-player-actions";
        [["edit", "Rename"], ["toggle", user.active ? "Deactivate" : "Reactivate"]].forEach(function (entry) {
          var button = document.createElement("button"); button.type = "button"; button.className = "button secondary";
          button.textContent = entry[1]; button.dataset.playerAction = entry[0]; button.dataset.playerId = user.id;
          button.setAttribute("aria-label", entry[1] + " " + user.name); button.disabled = locked(); actions.appendChild(button);
        });
        item.append(details, actions); el.adminPlayersList.appendChild(item);
      });
      if (previous && allowed) {
        var target = Array.from(el.adminPlayersList.querySelectorAll("button")).find(function (button) { return button.dataset.playerId === previous.id && button.dataset.playerAction === previous.action; });
        if (target) target.focus({ preventScroll: true });
      }
      renderDraft();
    }
    el.addPlayerButton.addEventListener("click", function () { open("add"); });
    el.adminPlayersList.addEventListener("click", function (event) { var button = event.target.closest("[data-player-action]"); if (button && !button.disabled) open(button.dataset.playerAction, button.dataset.playerId); });
    el.playerForm.addEventListener("input", function () { capture(); if (draft) { draft.error = ""; renderDraft(); } });
    el.closePlayerButton.addEventListener("click", function () { capture(); el.playerDialog.close(); });
    el.playerDialog.addEventListener("cancel", capture);
    el.playerDialog.addEventListener("close", function () {
      if (el.playerDialog.open || !draft) return;
      draft = null; var actor = auth.getSession();
      if (actor && actor.isAdmin) el.addPlayerButton.focus();
    });
    el.reloadPlayerButton.addEventListener("click", async function () {
      if (!draft || draft.pending || draft.loading) return;
      var value = draft; value.loading = true; renderDraft();
      try {
        var data = await store.refresh();
        if (draft !== value) return;
        var user = data.users.users.find(function (item) { return item.id === value.id; });
        if (!user) throw new Error("This player is no longer available.");
        value.original = { name: user.name, active: user.active }; value.values = { name: user.name, active: user.active };
        value.error = ""; value.submitted = false; showDraft();
      } catch (error) { value.error = error.message; }
      finally { value.loading = false; if (draft === value) renderDraft(); }
    });
    el.playerForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!draft || draft.pending || draft.loading || saving || !auth.requireWrite({ admin: true })) return;
      if (auth.getSession().userId !== draft.actorId) return;
      el.playerName.value = el.playerName.value.trim(); capture();
      var recovery = store.getRecovery(), action = intent();
      var retrying = recovery && matches(recovery.action, draft) && JSON.stringify(recovery.action) === JSON.stringify(action);
      if (!retrying && !el.playerForm.reportValidity()) return;
      var value = draft; value.action = action; value.submitted = true; value.pending = true; value.error = ""; renderDraft();
      try { if (retrying) await store.retry(); else await store.mutate(action); }
      catch (error) { value.error = error.message; if (error.outcome === "saved") drafts.delete(value.key); }
      finally { value.pending = false; if (draft === value) renderDraft(); }
    });
    window.addEventListener("early-birds-session-change", function () { capture(); el.playerDialog.close(); draft = null; render(); });
    store.subscribe(function (event) {
      saving = event.status.phase === "saving";
      if (event.data) latest = event.data;
      var recovery = store.getRecovery();
      drafts.forEach(function (value) {
        if (recovery && matches(recovery.action, value) && event.status.phase === "error") { value.pending = false; value.error = event.status.message; }
        var user = event.data && event.data.users.users.find(function (item) { return item.id === value.id; });
        var changes = value.action && (value.mode === "add" ? value.action.user : value.action.changes);
        if (value.submitted && event.status.save.outcome === "saved" && user && changes && Object.keys(changes).every(function (key) { return user[key] === changes[key]; })) {
          value.pending = false; drafts.delete(value.key);
          if (draft === value) { draft = null; el.playerDialog.close(); el.addPlayerButton.focus(); }
        }
      });
      render();
    });
    return Object.freeze({ render: render });
  }
  window.EarlyBirdsUsers = Object.freeze({ init: init });
})();
