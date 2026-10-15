(function (root) {
  "use strict";
  function createModel(config) {
    var booking = config.booking;
    function check(ok, message) { if (!ok) throw new Error(message); }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function text(value) { return typeof value === "string" && value.trim().length > 0; }
    function fields(value, allowed) {
      check(value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).every(function (key) { return allowed.indexOf(key) >= 0; }), "Unrecognised data fields.");
    }
    function date(value) {
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    }
    function timestamp(value) {
      return typeof value === "string" && /Z$/.test(value) && Number.isFinite(Date.parse(value));
    }
    function envelope(value, allowed) {
      fields(value, allowed);
      check(value.version === config.schemaVersion, "Unsupported data version. Review the shared data before saving.");
      check(timestamp(value.updatedAt) && typeof value.updatedBy === "string", "Invalid data metadata.");
    }
    function validateUsers(value) {
      envelope(value, ["version", "updatedAt", "updatedBy", "users"]);
      check(Array.isArray(value.users), "Invalid player directory.");
      var ids = new Set();
      value.users.forEach(function (user) {
        fields(user, ["id", "name", "active"]);
        check(text(user.id) && text(user.name) && typeof user.active === "boolean" && !ids.has(user.id), "Invalid or duplicate player.");
        ids.add(user.id);
      });
      check(!value.updatedBy || ids.has(value.updatedBy), "Unknown directory author.");
      return copy(value);
    }
    function validateState(value, directory) {
      validateUsers(directory);
      envelope(value, ["version", "updatedAt", "updatedBy", "courts", "bagels"]);
      check(Array.isArray(value.courts) && Array.isArray(value.bagels), "Invalid game data.");
      var known = new Set(directory.users.map(function (user) { return user.id; }));
      check(!value.updatedBy || known.has(value.updatedBy), "Unknown game-data author.");
      var ids = new Set(), slots = new Set(), places = new Set();
      value.courts.forEach(function (court) {
        fields(court, ["id", "date", "time", "durationMinutes", "courtNumber", "code", "bookedBy", "green", "reserved", "createdAt", "createdBy"]);
        check(text(court.id) && !ids.has(court.id), "Invalid or duplicate court ID."); ids.add(court.id);
        check(date(court.date) && typeof court.time === "string" && /^\d{2}:00$/.test(court.time) &&
          Number(court.time.slice(0, 2)) >= booking.firstStartHour && Number(court.time.slice(0, 2)) <= booking.lastStartHour &&
          court.durationMinutes === booking.durationMinutes, "Invalid court date or time.");
        check(Number.isInteger(court.courtNumber) && court.courtNumber >= booking.firstCourtNumber &&
          court.courtNumber <= booking.lastCourtNumber && typeof court.code === "string" && /^\d{6}$/.test(court.code), "Invalid court number or code.");
        check(known.has(court.bookedBy) && known.has(court.createdBy) && timestamp(court.createdAt), "Invalid booking author.");
        check(Array.isArray(court.green) && Array.isArray(court.reserved) && court.green.length <= booking.capacity, "Invalid court capacity.");
        var members = court.green.concat(court.reserved);
        check(new Set(members).size === members.length && members.every(function (id) { return known.has(id); }), "Invalid or duplicate court player.");
        var slot = court.date + "/" + court.time;
        check(!slots.has(slot + "/" + court.courtNumber), "That court is already booked at this time."); slots.add(slot + "/" + court.courtNumber);
        court.green.forEach(function (id) {
          check(!places.has(slot + "/" + id), "A player already has an overlapping green place."); places.add(slot + "/" + id);
        });
      });
      ids = new Set();
      value.bagels.forEach(function (bagel) {
        fields(bagel, ["id", "sourceCourtId", "date", "winners", "losers", "createdAt", "createdBy"]);
        check(text(bagel.id) && !ids.has(bagel.id), "Invalid or duplicate bagel ID."); ids.add(bagel.id);
        check((bagel.sourceCourtId === null || text(bagel.sourceCourtId)) && date(bagel.date) &&
          timestamp(bagel.createdAt) && known.has(bagel.createdBy), "Invalid bagel metadata.");
        check(Array.isArray(bagel.winners) && Array.isArray(bagel.losers) &&
          [1, 2].indexOf(bagel.winners.length) >= 0 && bagel.winners.length === bagel.losers.length, "Bagels need equal singles or doubles teams.");
        var players = bagel.winners.concat(bagel.losers);
        players.forEach(function (player) {
          fields(player, ["userId", "name"]);
          check(known.has(player.userId) && text(player.name), "Invalid bagel player.");
        });
        check(new Set(players.map(function (player) { return player.userId; })).size === players.length, "Bagel players must be distinct.");
      });
      return copy(value);
    }
    function londonClock(now) {
      var parts = new Intl.DateTimeFormat("en-GB", { timeZone: booking.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
      var values = {}; parts.forEach(function (part) { values[part.type] = part.value; });
      return { date: values.year + "-" + values.month + "-" + values.day, minutes: Number(values.hour) * 60 + Number(values.minute) };
    }
    function applyState(original, directory, action, actor, now) {
      var next = validateState(original, directory);
      var clock = londonClock(now);
      function admin() { check(actor.isAdmin, "Admin mode is required for this change."); }
      function active(id) { check(directory.users.some(function (user) { return user.id === id && user.active; }), "That player is not active."); }
      function owned(court) { check(court && (actor.isAdmin || court.bookedBy === actor.userId), "Only the booker or Admin can change this court."); }
      function future(court) { check(court.date > clock.date || (court.date === clock.date && Number(court.time.slice(0, 2)) * 60 > clock.minutes), "Bookings must start in the future."); }
      var court = next.courts.find(function (item) { return item.id === action.courtId; });
      active(actor.userId);
      switch (action.type) {
        case "court.add": {
          var input = action.court;
          fields(input, ["id", "date", "time", "courtNumber", "code", "bookedBy"]);
          var existing = next.courts.find(function (item) { return item.id === input.id; });
          if (existing) {
            check(["date", "time", "courtNumber", "code", "bookedBy"].every(function (key) { return existing[key] === input[key]; }), "This booking ID already has different details.");
            break;
          }
          check(actor.isAdmin || input.bookedBy === actor.userId, "Only Admin can book for another player."); active(input.bookedBy); future(input);
          next.courts.push(Object.assign({}, input, { durationMinutes: booking.durationMinutes, green: [input.bookedBy], reserved: [], createdAt: now, createdBy: actor.userId }));
          break;
        }
        case "court.patch":
          check(court, "This court no longer exists.");
          owned(court);
          fields(action.changes, ["date", "time", "courtNumber", "code", "bookedBy"]);
          Object.keys(action.changes).forEach(function (key) {
            if (key === "bookedBy") { admin(); active(action.changes[key]); }
            check(action.expected && Object.hasOwn(action.expected, key), "Original edit values are required.");
            check(court[key] === action.expected[key] || court[key] === action.changes[key], "This court was edited by someone else. Refresh and review your change.");
            court[key] = action.changes[key];
          });
          future(court); break;
        case "court.remove":
          if (court) {
            owned(court);
            if (action.expected) Object.keys(action.expected).forEach(function (key) {
              check(court[key] === action.expected[key], "This court was edited by someone else. Load latest details and confirm deletion again.");
            });
            next.courts = next.courts.filter(function (item) { return item.id !== court.id; });
          }
          break;
        case "participation.set": {
          check(court, "This court no longer exists.");
          var playerId = action.userId || actor.userId;
          if (playerId !== actor.userId) admin();
          check(["green", "reserved", "none"].indexOf(action.status) >= 0, "Invalid participation status.");
          if (action.status !== "none") active(playerId);
          var alreadyGreen = court.green.indexOf(playerId) >= 0;
          if ((alreadyGreen && action.status === "green") ||
            (court.reserved.indexOf(playerId) >= 0 && action.status === "reserved")) break;
          court.green = court.green.filter(function (id) { return id !== playerId; });
          court.reserved = court.reserved.filter(function (id) { return id !== playerId; });
          if (action.status === "green" && (alreadyGreen || court.green.length < booking.capacity)) court.green.push(playerId);
          else if (action.status !== "none") court.reserved.push(playerId);
          break;
        }
        case "bagel.add": {
          fields(action.bagel, ["id", "sourceCourtId", "date", "winnerIds", "loserIds"]);
          var bagel = action.bagel;
          var duplicate = next.bagels.find(function (item) { return item.id === bagel.id; });
          if (duplicate) {
            check(duplicate.date === bagel.date && duplicate.sourceCourtId === bagel.sourceCourtId &&
              JSON.stringify(duplicate.winners.map(function (p) { return p.userId; })) === JSON.stringify(bagel.winnerIds) &&
              JSON.stringify(duplicate.losers.map(function (p) { return p.userId; })) === JSON.stringify(bagel.loserIds), "This bagel ID already has different details.");
            break;
          }
          check(date(bagel.date) && bagel.date <= clock.date, "Bagel dates cannot be in the future.");
          var source = next.courts.find(function (item) { return item.id === bagel.sourceCourtId; });
          check(Array.isArray(bagel.winnerIds) && Array.isArray(bagel.loserIds), "Choose the bagel players.");
          if (!actor.isAdmin) {
            check(source && source.date === clock.date && bagel.date === source.date &&
              clock.minutes >= Number(source.time.slice(0, 2)) * 60 + booking.durationMinutes && source.green.indexOf(actor.userId) >= 0,
            "Bagels must be submitted by a green player after today's game.");
            check(bagel.winnerIds.concat(bagel.loserIds).every(function (id) { return source.green.indexOf(id) >= 0; }), "Choose players from this game's green list.");
          }
          function snapshots(ids) { return ids.map(function (id) {
            var user = directory.users.find(function (item) { return item.id === id; });
            check(user, "Unknown bagel player."); return { userId: id, name: user.name };
          }); }
          next.bagels.push({ id: bagel.id, sourceCourtId: bagel.sourceCourtId, date: bagel.date,
            winners: snapshots(bagel.winnerIds), losers: snapshots(bagel.loserIds), createdAt: now, createdBy: actor.userId });
          break;
        }
        case "bagel.remove": admin(); next.bagels = next.bagels.filter(function (item) { return item.id !== action.bagelId; }); break;
        case "courts.cleanup": next.courts = next.courts.filter(function (item) { return item.date >= clock.date; }); break;
        default: throw new Error("Unknown game-data action.");
      }
      validateState(next, directory);
      return next;
    }
    function applyUsers(original, action, actor) {
      var next = validateUsers(original);
      check(actor.isAdmin && next.users.some(function (user) { return user.id === actor.userId && user.active; }), "An active Admin is required.");
      if (action.type === "user.add") {
        fields(action.user, ["id", "name", "active"]);
        var existing = next.users.find(function (user) { return user.id === action.user.id; });
        if (existing) check(JSON.stringify(existing) === JSON.stringify(action.user), "This player ID already exists.");
        else next.users.push(copy(action.user));
      } else if (action.type === "user.patch") {
        var user = next.users.find(function (item) { return item.id === action.userId; });
        check(user, "Unknown player."); fields(action.changes, ["name", "active"]);
        Object.keys(action.changes).forEach(function (key) {
          check(action.expected && Object.hasOwn(action.expected, key) &&
            (user[key] === action.expected[key] || user[key] === action.changes[key]), "This player was edited by someone else. Refresh and review your change.");
          user[key] = action.changes[key];
        });
      } else throw new Error("Unknown player-data action.");
      return validateUsers(next);
    }
    return Object.freeze({ validateUsers: validateUsers, validateState: validateState, applyState: applyState, applyUsers: applyUsers, londonClock: londonClock });
  }
  if (typeof module === "object" && module.exports) module.exports = createModel;
  else root.createEarlyBirdsModel = createModel;
})(typeof window === "undefined" ? globalThis : window);
