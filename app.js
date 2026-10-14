(function () {
  "use strict";

  var config = window.EarlyBirdsConfig;
  var activeTab = "games";
  var tabs;
  var panels;
  var canAdmin = false;
  var emptyMessages = {
    games: ["No courts to show yet", "Upcoming games will appear here."],
    admin: ["No admin items to show yet", "Player and court management will appear here."],
    bagels: ["No bagels to show yet", "Recorded 6–0 sets will appear here."],
  };

  function init() {
    document.title = config.appName;
    document.getElementById("app-title").textContent = config.appName;
    document.getElementById("appVersion").textContent = config.appVersion;
    tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () { selectTab(tab.dataset.tab); });
      tab.addEventListener("keydown", handleTabKey);
    });
    Object.keys(emptyMessages).forEach(function (name) { setPanelState(name, "empty"); });
    setAccess({ signedIn: false, isAdmin: false });

    // Integration points for sign-in (2.3) and shared-data loading (2.4).
    // This controls the interface; GitHub token permissions govern writes.
    window.EarlyBirdsUI = Object.freeze({
      setAccess: setAccess,
      selectTab: selectTab,
      setPanelState: setPanelState,
    });
    window.EarlyBirdsAuth.init();
  }

  function selectTab(name) {
    if (!emptyMessages[name] || (name === "admin" && !canAdmin)) return false;
    activeTab = name;
    document.body.dataset.tab = name;
    tabs.forEach(function (tab) {
      var selected = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== name;
    });
    return true;
  }

  function handleTabKey(event) {
    var visible = tabs.filter(function (tab) { return !tab.hidden; });
    var current = visible.indexOf(event.currentTarget);
    var next;
    if (event.key === "ArrowRight") next = (current + 1) % visible.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + visible.length) % visible.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visible.length - 1;
    else return;
    event.preventDefault();
    selectTab(visible[next].dataset.tab);
    visible[next].focus();
  }

  function setAccess(access) {
    canAdmin = Boolean(access.signedIn && access.isAdmin);
    var adminTab = document.getElementById("adminTabButton");
    var adminPanel = document.getElementById("adminPanel");
    var losingAdminFocus = !canAdmin &&
      (document.activeElement === adminTab || adminPanel.contains(document.activeElement));
    adminTab.hidden = !canAdmin;
    document.body.dataset.auth = access.signedIn ? "signed-in" : "signed-out";
    document.body.dataset.admin = String(canAdmin);
    document.getElementById("sessionSummary").textContent = access.signedIn
      ? (canAdmin ? "Admin mode" : "Player") : "Visitor";
    selectTab(activeTab === "admin" && !canAdmin ? "games" : activeTab);
    if (losingAdminFocus) document.getElementById("gamesTabButton").focus();
  }

  // The caller supplies rendered list content separately; status messages use
  // textContent so errors/data cannot inject markup into the page.
  function setPanelState(name, state, message) {
    if (!emptyMessages[name] || ["loading", "empty", "error", "ready"].indexOf(state) < 0) {
      throw new Error("Unknown panel or panel state");
    }
    var panel = panels.find(function (item) { return item.dataset.panel === name; });
    var box = panel.querySelector("[data-state-box]");
    var title = panel.querySelector("[data-state-title]");
    var description = panel.querySelector("[data-state-description]");
    var status = panel.querySelector("[data-panel-status]");
    var error = panel.querySelector("[data-panel-error]");
    panel.setAttribute("aria-busy", String(state === "loading"));
    panel.dataset.state = state;
    box.hidden = state === "ready";
    panel.querySelector("[data-panel-content]").hidden = state !== "ready";
    status.textContent = state === "loading" ? "Loading " + name + "…" : "";
    error.textContent = state === "error" ? (message || "Please try again later.") : "";
    if (state === "empty") {
      title.textContent = emptyMessages[name][0];
      description.textContent = message || emptyMessages[name][1];
    } else if (state === "loading") {
      title.textContent = "Loading " + name + "…";
      description.textContent = "Please wait while the latest information is loaded.";
    } else if (state === "error") {
      title.textContent = "Could not load " + name;
      description.textContent = "The latest information is unavailable.";
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
