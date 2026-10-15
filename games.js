(function () {
  "use strict";
  function init(options) {
    var list = document.getElementById("gamesList");
    var auth = options.auth;
    var store = options.store;
    var feedback = new Map();
    var mutating = false;
    var storeSaving = false;
    var activeAction = null;
    var requestedOpenPlace = false;
    var latest = null;
    function actionMessage(action, data) {
      var court = data.state.courts.find(function (item) { return item.id === action.courtId; });
      if (!court) return "This court no longer exists. Refresh to see the latest games.";
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
      list.querySelectorAll(".game-card").forEach(function (card) {
        var value = feedback.get(card.dataset.courtId);
        card.querySelector(".participation-status").textContent = value && !value.error ? value.message : "";
        card.querySelector(".participation-error").textContent = value && value.error ? value.message : "";
      });
    }
    function focusAction(courtId, status) {
      var card = Array.from(list.querySelectorAll(".game-card")).find(function (item) { return item.dataset.courtId === courtId; });
      if (!card) return;
      var buttons = Array.from(card.querySelectorAll("[data-participation]"));
      var target = buttons.find(function (button) { return button.dataset.participation === status && !button.disabled; }) ||
        buttons.find(function (button) { return !button.disabled; });
      if (target) target.focus({ preventScroll: true });
    }
    async function changePlace(courtId, status) {
      if (locked() || !auth.requireWrite()) return;
      var actor = auth.getSession();
      var action = { type: "participation.set", courtId: courtId, userId: actor.userId, status: status };
      var shownCourt = latest && latest.state.courts.find(function (court) { return court.id === courtId; });
      requestedOpenPlace = status === "green" && shownCourt && shownCourt.green.length < options.config.booking.capacity;
      mutating = true;
      feedback.set(courtId, { message: "Saving your place…", error: false });
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
        if (live && live.userId === actor.userId) focusAction(courtId, status);
      }
    }
    store.subscribe(function (event) {
      storeSaving = event.status.phase === "saving";
      var recovery = store.getRecovery();
      if (storeSaving && recovery && recovery.action.type === "participation.set") {
        activeAction = Object.assign({}, recovery.action);
        if (!activeAction.userId && auth.getSession()) activeAction.userId = auth.getSession().userId;
      }
      var actor = auth.getSession();
      if (activeAction && event.status.phase !== "saving" && event.status.phase !== "loading") {
        if (actor && actor.userId === activeAction.userId) {
          var saved = event.status.save.outcome === "saved" && event.data;
          var message = saved ? actionMessage(activeAction, event.data) : event.status.message;
          if (!saved && message.indexOf("overlapping") >= 0) message = "You already have a place in another game at this time. Choose Reserve instead.";
          var court = event.data && event.data.state.courts.find(function (item) { return item.id === activeAction.courtId; });
          feedback.set(activeAction.courtId, { message: message, error: !saved, membership: saved && court ? JSON.stringify([court.green, court.reserved]) : null });
        }
        activeAction = null;
      }
      updateControls();
    });
    window.addEventListener("early-birds-session-change", function () {
      feedback.clear();
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
    function render(data) {
      latest = data;
      var focused = document.activeElement;
      var previousFocus = focused && focused.dataset.participation && focused.closest(".game-card");
      var focusTarget = previousFocus ? { courtId: previousFocus.dataset.courtId, status: focused.dataset.participation } : null;
      var names = new Map(data.users.users.map(function (user) { return [user.id, user.name]; }));
      function name(id) { return names.get(id) || "Unknown player"; }
      var courts = data.state.courts.slice().sort(function (a, b) {
        return a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.courtNumber - b.courtNumber || a.id.localeCompare(b.id);
      });
      list.replaceChildren();
      courts.forEach(function (court, index) {
        var previousMessage = feedback.get(court.id);
        if (previousMessage && previousMessage.membership && previousMessage.membership !== JSON.stringify([court.green, court.reserved])) feedback.delete(court.id);
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
      updateControls();
      if (focusTarget && !mutating) focusAction(focusTarget.courtId, focusTarget.status);
    }
    return Object.freeze({ render: render });
  }
  window.EarlyBirdsGames = Object.freeze({ init: init });
})();
