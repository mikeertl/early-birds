(function () {
  "use strict";
  function init(options) {
    var list = document.getElementById("gamesList");
    var auth = options.auth;
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
      var names = new Map(data.users.users.map(function (user) { return [user.id, user.name]; }));
      function name(id) { return names.get(id) || "Unknown player"; }
      var courts = data.state.courts.slice().sort(function (a, b) {
        return a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.courtNumber - b.courtNumber || a.id.localeCompare(b.id);
      });
      list.replaceChildren();
      courts.forEach(function (court, index) {
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
        card.append(details, players); list.appendChild(card);
        auth.renderCourtCode(code, court.code);
      });
      options.ui.setPanelState("games", courts.length ? "ready" : "empty");
    }
    return Object.freeze({ render: render });
  }
  window.EarlyBirdsGames = Object.freeze({ init: init });
})();
