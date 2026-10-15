(function () {
  "use strict";
  function init(options) {
    var list = document.getElementById("gamesList");
    var adminList = document.getElementById("adminCourtsList");
    var auth = options.auth;
    var store = options.store;
    var feedback = new Map();
    var mutating = false;
    var storeSaving = false;
    var activeAction = null;
    var activeActorId = null;
    var selectedPlayers = new Map();
    var requestedOpenPlace = false;
    var latest = null;
    function actionMessage(action, data) {
      var court = data.state.courts.find(function (item) { return item.id === action.courtId; });
      if (!court) return "This court no longer exists. Refresh to see the latest games.";
      if (action.asAdmin) {
        var user = data.users.users.find(function (item) { return item.id === action.userId; });
        var name = user ? user.name : "Player";
        if (action.status === "none") return name + " has been removed from this game.";
        if (court.green.indexOf(action.userId) >= 0) return name + " is now playing in this game.";
        return action.status === "green" ? "Court full. " + name + " is reserved for this game." : name + " is now reserved for this game.";
      }
      if (action.status === "none") return "You have been removed from this game.";
      if (court.green.indexOf(action.userId) >= 0) return "You are playing in this game.";
      return action.status === "green" ? (requestedOpenPlace ? "Another player took the last place. You are now reserved for this game." : "This court is full. You have been added as a reserve.") : "You are now reserved for this game.";
    }
    function locked() {
      var recovery = store.getRecovery();
      return mutating || storeSaving || Boolean(recovery && recovery.outcome === "uncertain");
    }
    function updateControls() {
      list.querySelectorAll("[data-participation]").forEach(function (button) {
        button.disabled = locked() || button.dataset.overlap === "true";
      });
      document.querySelectorAll("[data-court-management]").forEach(function (button) { button.disabled = locked(); });
      document.querySelectorAll("[data-bagel-court]").forEach(function (button) { button.disabled = locked(); });
      adminList.querySelectorAll("[data-admin-participation]").forEach(function (button) {
        button.disabled = locked() || button.dataset.overlap === "true" || button.dataset.unavailable === "true";
      });
      adminList.querySelectorAll("[data-admin-player-select]").forEach(function (select) { select.disabled = locked(); });
      list.querySelectorAll(".game-card").forEach(function (card) {
        var value = feedback.get(card.dataset.courtId);
        card.querySelector(".participation-status").textContent = value && !value.error ? value.message : "";
        card.querySelector(".participation-error").textContent = value && value.error ? value.message : "";
      });
      adminList.querySelectorAll(".game-card").forEach(function (card) {
        var value = feedback.get("admin:" + card.dataset.courtId);
        card.querySelector(".admin-participation-status").textContent = value && !value.error ? value.message : "";
        card.querySelector(".admin-participation-error").textContent = value && value.error ? value.message : "";
      });
    }
    function focusAction(courtId, status, userId, fromAdmin) {
      var card = Array.from((fromAdmin ? adminList : list).querySelectorAll(".game-card")).find(function (item) { return item.dataset.courtId === courtId; });
      if (!card) return;
      if (fromAdmin) {
        var controls = Array.from(card.querySelectorAll("[data-admin-participation]"));
        var control = controls.find(function (item) { return item.dataset.userId === userId && item.dataset.adminParticipation === status && !item.disabled; }) ||
          controls.find(function (item) { return item.dataset.userId === userId && !item.disabled; }) || card.querySelector("[data-admin-player-select]");
        if (control) control.focus({ preventScroll: true });
        return;
      }
      var buttons = Array.from(card.querySelectorAll("[data-participation]"));
      var target = buttons.find(function (button) { return button.dataset.participation === status && !button.disabled; }) ||
        buttons.find(function (button) { return !button.disabled; });
      if (target) target.focus({ preventScroll: true });
    }
    async function changePlace(courtId, status, userId, fromAdmin) {
      if (locked() || !auth.requireWrite(fromAdmin ? { admin: true } : undefined)) return;
      var actor = auth.getSession();
      var action = { type: "participation.set", courtId: courtId, userId: userId || actor.userId, status: status };
      if (fromAdmin) action.asAdmin = true;
      var shownCourt = latest && latest.state.courts.find(function (court) { return court.id === courtId; });
      requestedOpenPlace = status === "green" && shownCourt && shownCourt.green.length < options.config.booking.capacity;
      mutating = true;
      feedback.set((fromAdmin ? "admin:" : "") + courtId, { message: fromAdmin ? "Saving player place…" : "Saving your place…", error: false });
      updateControls();
      try {
        var recovery = store.getRecovery();
        if (recovery && JSON.stringify(recovery.action) === JSON.stringify(action)) await store.retry();
        else await store.mutate(action);
      } catch (error) {
        // Re-read after a definite rejection: the court or another membership
        // may have changed since this screen was drawn. Keep the failed intent.
        if (error.outcome === "failed") {
          try { await store.refresh(); } catch (_) { /* Keep the last good cards and recovery message. */ }
        }
      }
      finally {
        mutating = false; updateControls();
        var live = auth.getSession();
        if (live && live.userId === actor.userId && (!fromAdmin || live.isAdmin)) focusAction(courtId, status, action.userId, fromAdmin);
      }
    }
    store.subscribe(function (event) {
      storeSaving = event.status.phase === "saving";
      var recovery = store.getRecovery();
      if (storeSaving && recovery && recovery.action.type === "participation.set") {
        activeAction = Object.assign({}, recovery.action);
        activeActorId = auth.getSession() && auth.getSession().userId;
        if (!activeAction.userId && auth.getSession()) activeAction.userId = auth.getSession().userId;
      }
      var actor = auth.getSession();
      if (activeAction && event.status.phase !== "saving" && event.status.phase !== "loading") {
        if (actor && actor.userId === activeActorId && (activeAction.asAdmin ? actor.isAdmin : actor.userId === activeAction.userId)) {
          var saved = event.status.save.outcome === "saved" && event.data;
          var message = saved ? actionMessage(activeAction, event.data) : event.status.message;
          if (!saved && message.indexOf("overlapping") >= 0) message = activeAction.asAdmin ? "This player already has a playing place at this time. Choose Reserve instead." : "You already have a place in another game at this time. Choose Reserve instead.";
          var court = event.data && event.data.state.courts.find(function (item) { return item.id === activeAction.courtId; });
          feedback.set((activeAction.asAdmin ? "admin:" : "") + activeAction.courtId, { message: message, error: !saved, membership: saved && court ? JSON.stringify([court.green, court.reserved]) : null });
        }
        activeAction = null;
      }
      updateControls();
    });
    window.addEventListener("early-birds-session-change", function () {
      feedback.clear();
      selectedPlayers.clear();
      if (latest) render(latest);
    });
    function element(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function formatDate(key) {
      // The stored value is a London calendar date, not a UTC instant. Format
      // its calendar parts without shifting the day to the device timezone.
      var parts = {};
      new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" })
        .formatToParts(new Date(key + "T12:00:00Z")).forEach(function (part) { parts[part.type] = part.value; });
      return parts.weekday + " " + parts.day + " " + parts.month + " " + parts.year;
    }
    function formatTime(time) {
      var hour = Number(time.slice(0, 2));
      return (hour % 12 || 12) + ":" + time.slice(3) + (hour < 12 ? "am" : "pm");
    }
    function managementActions(court) {
      var management = element("div", "game-actions");
      ["edit", "delete"].forEach(function (action) {
        var control = element("button", "button secondary", action === "edit" ? "Edit court" : "Delete court");
        control.type = "button"; control.dataset.courtManagement = action;
        control.setAttribute("aria-label", control.textContent + ": Court " + court.courtNumber + ", " + formatDate(court.date) + " at " + formatTime(court.time));
        management.appendChild(control);
      });
      return management;
    }
    function adminPlayers(court, index, data, courts) {
      var users = new Map(data.users.users.map(function (user) { return [user.id, user]; }));
      var full = court.green.length >= options.config.booking.capacity;
      function overlaps(id) {
        return !full && courts.some(function (other) { return other.id !== court.id && other.date === court.date && other.time === court.time && other.green.indexOf(id) >= 0; });
      }
      function control(label, status, id) {
        var button = element("button", "button secondary", label); button.type = "button";
        button.dataset.adminParticipation = status; button.dataset.userId = id || "";
        button.dataset.overlap = String(Boolean(id && status === "green" && overlaps(id)));
        button.dataset.unavailable = String(!id || (!users.get(id).active && status !== "none"));
        button.setAttribute("aria-label", label + (id ? " · " + users.get(id).name : "") + ": Court " + court.courtNumber + ", " + formatDate(court.date) + " at " + formatTime(court.time));
        button.addEventListener("click", function () { if (!button.disabled) changePlace(court.id, status, button.dataset.userId, true); });
        return button;
      }
      var section = element("section", "admin-court-players"); section.setAttribute("aria-label", "Manage this court's players");
      [["Playing · " + court.green.length + " / " + options.config.booking.capacity, court.green, "playing-player"], ["Reserved · " + court.reserved.length, court.reserved, "reserved-player"]].forEach(function (group, groupIndex) {
        var area = element("div", "admin-player-group"); area.appendChild(element("h4", "player-group-title", group[0]));
        var members = element("ul", "admin-members");
        group[1].forEach(function (id) {
          var user = users.get(id), item = element("li", "admin-member");
          item.appendChild(element("span", "player-chip " + group[2], user.name + (user.active ? "" : " (inactive)")));
          var actions = element("div", "game-actions");
          actions.append(control(groupIndex === 0 ? "Make reserve" : "Make playing", groupIndex === 0 ? "reserved" : "green", id), control("Remove", "none", id));
          item.appendChild(actions);
          if (groupIndex === 1 && overlaps(id)) item.appendChild(element("p", "field-help", "Already playing another court at this time. Can stay reserved here."));
          members.appendChild(item);
        });
        if (group[1].length) area.appendChild(members);
        else area.appendChild(element("p", "player-empty", groupIndex === 0 ? "Nobody is playing yet." : "No reserves."));
        section.appendChild(area);
      });
      var add = element("div", "admin-add-player");
      var label = element("label", "", "Add player"); label.htmlFor = "admin-court-player-" + index;
      var select = element("select"); select.id = label.htmlFor; select.dataset.adminPlayerSelect = "true";
      select.add(new Option("Choose an active player", ""));
      data.users.users.filter(function (user) { return user.active && court.green.indexOf(user.id) < 0 && court.reserved.indexOf(user.id) < 0; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (user) { select.add(new Option(user.name, user.id)); });
      select.value = selectedPlayers.get(court.id) || "";
      if (!select.value) selectedPlayers.delete(court.id);
      var actions = element("div", "game-actions"), green = control("Add to playing", "green", select.value), reserve = control("Add reserve", "reserved", select.value);
      var help = element("p", "field-help admin-add-help"); actions.append(green, reserve);
      function updateSelection() {
        selectedPlayers.set(court.id, select.value);
        [green, reserve].forEach(function (button) {
          button.dataset.userId = select.value; button.dataset.unavailable = String(!select.value);
          button.dataset.overlap = String(Boolean(select.value && button === green && overlaps(select.value)));
        });
        help.textContent = select.options.length === 1 ? "All active players are already listed." :
          select.value && overlaps(select.value) ? "This player is already playing another court at this time. You can add them as a reserve." :
            full ? "Court full. Add to playing adds the selected player as a reserve." : "Add an active player to playing or reserve. Reserves are never moved automatically.";
        updateControls();
      }
      select.addEventListener("change", updateSelection);
      add.append(label, select, actions, help); section.appendChild(add);
      var status = element("p", "admin-participation-status status-line"); status.setAttribute("role", "status"); status.setAttribute("aria-atomic", "true");
      var error = element("p", "admin-participation-error error-line"); error.setAttribute("role", "alert"); error.setAttribute("aria-atomic", "true");
      section.append(status, error);
      // Initialise the new controls before they are inserted into the live card.
      help.textContent = full ? "Court full. Add to playing adds the selected player as a reserve." : "Add an active player to playing or reserve. Reserves are never moved automatically.";
      if (select.value && overlaps(select.value)) help.textContent = "This player is already playing another court at this time. You can add them as a reserve.";
      return section;
    }
    function bagelButton(court, fromAdmin) {
      var button = element("button", "button secondary", "Bagel?");
      button.type = "button"; button.dataset.bagelCourt = court.id; button.dataset.bagelAdmin = String(fromAdmin);
      button.setAttribute("aria-label", "Bagel?: Court " + court.courtNumber + ", " + formatDate(court.date) + " at " + formatTime(court.time));
      return button;
    }
    function render(data) {
      latest = data;
      var focused = document.activeElement;
      var previousFocus = focused && focused.dataset.participation && focused.closest(".game-card");
      var focusTarget = previousFocus ? { courtId: previousFocus.dataset.courtId, status: focused.dataset.participation } : null;
      var bagelFocus = focused && focused.matches("[data-bagel-court]") ? { id: focused.dataset.bagelCourt, admin: focused.dataset.bagelAdmin } : null;
      var adminFocusCard = focused && focused.closest("#adminCourtsList .game-card");
      var adminFocus = adminFocusCard && (focused.matches("[data-admin-participation]") || focused.matches("[data-admin-player-select]")) ?
        { courtId: adminFocusCard.dataset.courtId, status: focused.dataset.adminParticipation, userId: focused.dataset.userId, select: focused.matches("select") } : null;
      var names = new Map(data.users.users.map(function (user) { return [user.id, user.name]; }));
      function name(id) { return names.get(id) || "Unknown player"; }
      var today = options.model.londonClock(new Date().toISOString()).date;
      var courts = data.state.courts.filter(function (court) { return court.date >= today; }).sort(function (a, b) {
        return a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.courtNumber - b.courtNumber || a.id.localeCompare(b.id);
      });
      list.replaceChildren();
      adminList.replaceChildren();
      courts.forEach(function (court, index) {
        var previousMessage = feedback.get(court.id);
        if (previousMessage && previousMessage.membership && previousMessage.membership !== JSON.stringify([court.green, court.reserved])) feedback.delete(court.id);
        var adminMessage = feedback.get("admin:" + court.id);
        if (adminMessage && adminMessage.membership && adminMessage.membership !== JSON.stringify([court.green, court.reserved])) feedback.delete("admin:" + court.id);
        var card = element("article", "game-card");
        card.dataset.courtId = court.id;
        var details = element("div", "game-details");
        var heading = element("h3", "game-date");
        heading.id = "game-title-" + index;
        card.setAttribute("aria-labelledby", heading.id);
        var date = element("time", "", formatDate(court.date));
        date.dateTime = court.date;
        heading.appendChild(date);
        var meta = element("p", "game-meta");
        meta.append(element("span", "game-time", formatTime(court.time)), element("span", "game-court", "Court " + court.courtNumber));
        var facts = element("dl", "game-facts");
        var booker = element("div");
        booker.append(element("dt", "", "Booked by"), element("dd", "game-booker", name(court.bookedBy)));
        var access = element("div");
        var code = element("span", "game-code");
        var codeValue = element("dd"); codeValue.appendChild(code);
        access.append(element("dt", "", "Code"), codeValue);
        facts.append(booker, access);
        details.append(heading, meta, facts);
        var manager = auth.getSession();
        if (manager && court.bookedBy === manager.userId) details.appendChild(managementActions(court));
        if (manager && manager.isAdmin) {
          var adminCard = element("article", "game-card admin-court-card");
          adminCard.dataset.courtId = court.id;
          var adminDetails = details.cloneNode(true);
          adminDetails.querySelectorAll(".game-actions").forEach(function (node) { node.remove(); });
          adminDetails.querySelector("h3").id = "admin-court-title-" + index;
          adminCard.setAttribute("aria-labelledby", "admin-court-title-" + index);
          adminDetails.appendChild(managementActions(court));
          if (options.model.canReportBagel(court, manager, new Date().toISOString(), true)) adminDetails.querySelector(".game-actions").appendChild(bagelButton(court, true));
          adminCard.append(adminDetails, adminPlayers(court, index, data, courts)); adminList.appendChild(adminCard);
          auth.renderCourtCode(adminDetails.querySelector(".game-code"), court.code);
        }
        var players = element("div", "game-players");
        var playing = element("section", "player-group");
        playing.setAttribute("aria-label", "Playing");
        playing.appendChild(element("h4", "player-group-title", "Playing · " + court.green.length + " / " + options.config.booking.capacity));
        if (court.green.length) {
          var green = element("ul", "player-list");
          court.green.forEach(function (id) { green.appendChild(element("li", "player-chip playing-player", name(id))); });
          playing.appendChild(green);
        } else playing.appendChild(element("p", "player-empty", "Nobody has joined yet."));
        players.appendChild(playing);
        if (court.reserved.length) {
          var reserved = element("section", "player-group");
          reserved.setAttribute("aria-label", "Reserved");
          reserved.appendChild(element("h4", "player-group-title", "Reserved · " + court.reserved.length));
          var yellow = element("ul", "player-list");
          court.reserved.forEach(function (id) { yellow.appendChild(element("li", "player-chip reserved-player", name(id))); });
          reserved.appendChild(yellow); players.appendChild(reserved);
        }
        var session = auth.getSession();
        var userId = session && session.userId;
        var isGreen = userId && court.green.indexOf(userId) >= 0;
        var isReserved = userId && court.reserved.indexOf(userId) >= 0;
        var full = court.green.length >= options.config.booking.capacity;
        var overlap = userId && !isGreen && !full && courts.some(function (other) {
          return other.id !== court.id && other.date === court.date && other.time === court.time && other.green.indexOf(userId) >= 0;
        });
        var actions = element("div", "game-actions");
        actions.setAttribute("role", "group"); actions.setAttribute("aria-label", "Your place in this game");
        function button(label, status) {
          var control = element("button", "button secondary", label);
          control.type = "button"; control.dataset.participation = status;
          control.dataset.overlap = String(status === "green" && Boolean(overlap));
          control.setAttribute("aria-label", label + ": Court " + court.courtNumber + ", " + formatDate(court.date) + " at " + formatTime(court.time));
          control.addEventListener("click", function () { changePlace(court.id, status); });
          actions.appendChild(control);
        }
        if (!isGreen && (!isReserved || !full)) button("Add me", "green");
        if (isGreen || isReserved) button("Remove me", "none");
        if (!isReserved) button("Reserve", "reserved");
        if (options.model.canReportBagel(court, session, new Date().toISOString(), false)) actions.appendChild(bagelButton(court, false));
        players.appendChild(actions);
        if (overlap) players.appendChild(element("p", "participation-help field-help", "You already have a place in another game at this time. You can still reserve."));
        else if (full && !isGreen && !isReserved) players.appendChild(element("p", "participation-help field-help", "Court full. Add me joins the reserves."));
        else if (isReserved && !full) players.appendChild(element("p", "participation-help field-help", "A place is open. Choose Add me to play; reserves are not moved automatically."));
        var statusLine = element("p", "participation-status status-line");
        statusLine.setAttribute("role", "status"); statusLine.setAttribute("aria-atomic", "true");
        var errorLine = element("p", "participation-error error-line");
        errorLine.setAttribute("role", "alert"); errorLine.setAttribute("aria-atomic", "true");
        players.append(statusLine, errorLine);
        card.append(details, players); list.appendChild(card);
        auth.renderCourtCode(code, court.code);
      });
      options.ui.setPanelState("games", courts.length ? "ready" : "empty");
      var actor = auth.getSession();
      document.getElementById("adminPlayerCount").textContent = actor && actor.isAdmin ? data.users.users.filter(function (user) { return user.active; }).length + " active players." : "";
      document.getElementById("adminCourtsEmpty").hidden = courts.length > 0;
      options.ui.setPanelState("admin", actor && actor.isAdmin ? "ready" : "empty");
      document.getElementById("historicalBagelButton").hidden = !actor || !actor.isAdmin;
      document.getElementById("adminAddCourtButton").hidden = !actor || !actor.isAdmin;
      updateControls();
      options.bagels.update(data);
      if (focusTarget && !mutating) focusAction(focusTarget.courtId, focusTarget.status);
      if (adminFocus && !mutating) {
        if (adminFocus.select) {
          var card = Array.from(adminList.querySelectorAll(".game-card")).find(function (item) { return item.dataset.courtId === adminFocus.courtId; });
          if (card) card.querySelector("[data-admin-player-select]").focus({ preventScroll: true });
        } else focusAction(adminFocus.courtId, adminFocus.status, adminFocus.userId, true);
      }
      if (bagelFocus) {
        var target = Array.from(document.querySelectorAll("[data-bagel-court]")).find(function (button) { return button.dataset.bagelCourt === bagelFocus.id && button.dataset.bagelAdmin === bagelFocus.admin && !button.hidden; });
        (target || document.getElementById(bagelFocus.admin === "true" ? "adminTabButton" : "gamesTabButton")).focus({ preventScroll: true });
      }
    }
    return Object.freeze({ render: render });
  }
  window.EarlyBirdsGames = Object.freeze({ init: init });
})();
