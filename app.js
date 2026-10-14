(function () {
  "use strict";

  var config = window.EarlyBirdsConfig;

  function init() {
    document.title = config.appName;
    document.getElementById("app-title").textContent = config.appName;
    document.getElementById("appVersion").textContent = config.appVersion;
  }

  document.addEventListener("DOMContentLoaded", init);
})();
