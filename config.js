(function () {
  "use strict";

  // Public configuration only. Tokens must never be added to this file.
  window.EarlyBirdsConfig = Object.freeze({
    appName: "Early Birds Tennis",
    appVersion: "2026.10.14.1",
    schemaVersion: 1,
    github: Object.freeze({
      owner: "mikeertl",
      repo: "early-birds",
      branch: "main",
      statePath: "data/current.json",
      usersPath: "data/users.json",
    }),
    storageKeys: Object.freeze({
      state: "early-birds-state-v1",
      users: "early-birds-users-v1",
      pendingState: "early-birds-pending-state-v1",
      token: "early-birds-github-token",
      userId: "early-birds-user-id",
      adminMode: "early-birds-admin-mode",
      adminPanels: "early-birds-admin-panels-v1",
    }),
    booking: Object.freeze({
      timeZone: "Europe/London",
      defaultTime: "08:00",
      firstStartHour: 7,
      lastStartHour: 21,
      durationMinutes: 60,
      firstCourtNumber: 1,
      lastCourtNumber: 6,
      codeLength: 6,
      capacity: 4,
    }),
  });
})();
