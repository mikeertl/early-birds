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
    var header = initHeader();
    var bagelMotion = window.matchMedia("(prefers-reduced-motion: reduce)"), bagelPaused = false;
    function renderBagelAnimation() {
      var button = document.getElementById("bagelAnimationButton");
      var still = bagelPaused || bagelMotion.matches;
      document.getElementById("bagelAnimation").src = still ? "assets/bagel-still.png" : "assets/bagel.gif";
      button.setAttribute("aria-pressed", String(bagelPaused));
      button.textContent = bagelPaused ? "Resume animation" : "Pause animation";
      button.hidden = bagelMotion.matches;
    }
    document.getElementById("bagelAnimationButton").addEventListener("click", function () {
      bagelPaused = !bagelPaused; renderBagelAnimation();
    });
    bagelMotion.addEventListener("change", renderBagelAnimation);
    renderBagelAnimation();
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Tab") return;
      var dialog = document.activeElement.closest("dialog[open]");
      if (!dialog) return;
      var controls = Array.from(dialog.querySelectorAll("button,input,select,textarea,a[href],summary,[tabindex]"))
        .filter(function (control) { return control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length; });
      if (!controls.length) return;
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
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
      setNotice: header.notice,
    });
    var auth = window.EarlyBirdsAuth;
    var model = window.createEarlyBirdsModel(config);
    var store = window.createEarlyBirdsStore({
      config: config, model: model, fetch: window.fetch.bind(window),
      getSession: auth.getSession, requireWrite: auth.requireWrite,
      isLocal: ["localhost", "127.0.0.1", "[::1]"].indexOf(window.location.hostname) >= 0,
    });
    window.EarlyBirdsStore = store;
    var bagels = window.EarlyBirdsBagels.init({ auth: auth, store: store, model: model, config: config, ui: window.EarlyBirdsUI });
    var users = window.EarlyBirdsUsers.init({ auth: auth, store: store });
    var games = window.EarlyBirdsGames.init({ auth: auth, store: store, model: model, config: config, bagels: bagels, ui: window.EarlyBirdsUI });
    store.subscribe(function (event) {
      var phase = event.status.phase;
      var pending = phase === "loading" || phase === "saving";
      header.network(pending, phase === "saving");
      document.getElementById("refreshButton").disabled = pending;
      header.notice("dataStatus", phase === "error" ? "" : event.status.message +
        (event.status.source === "local" && phase === "ready" ? " Viewing local preview data." : ""));
      document.getElementById("dataError").textContent = phase === "error" ? event.status.message : "";
      var save = event.status.save;
      var saveFailed = save.outcome === "failed" || save.outcome === "uncertain";
      header.notice("saveStatus", saveFailed ? "" : save.message);
      document.getElementById("saveError").textContent = saveFailed ? save.message : "";
      header.notice("cleanupNotice", event.status.cleanup.message, ["failed", "deferred"].indexOf(event.status.cleanup.outcome) >= 0);
      document.getElementById("staleNotice").hidden = !event.status.stale;
      document.getElementById("retrySaveButton").hidden = !save.canRetry;
      document.getElementById("retrySaveButton").disabled = pending;
      if (phase === "ready" && event.data) {
        auth.setUsers(event.data.users);
        games.render(event.data);
        bagels.renderList(event.data);
        users.render(event.data);
      } else if (!event.data) {
        Object.keys(emptyMessages).forEach(function (name) { setPanelState(name, phase === "error" ? "error" : "loading", event.status.message); });
      }
    });
    function refresh() { cleanupDue = false; return store.refresh().catch(function () { /* The store publishes a safe error message. */ }); }
    document.getElementById("refreshButton").addEventListener("click", refresh);
    document.getElementById("retrySaveButton").addEventListener("click", function () {
      store.retry().catch(function () { /* The store keeps the change and publishes its outcome. */ });
    });
    window.EarlyBirdsBooking.init({ store: store, auth: auth, model: model, config: config });
    var displayedDay = model.londonClock(new Date().toISOString()).date;
    var cleanupDue = false;
    function checkExpiry() {
      var day = model.londonClock(new Date().toISOString()).date;
      if (day !== displayedDay) {
        displayedDay = day; cleanupDue = true;
      }
      // Eligibility also changes when an hour-long game ends during the day.
      var data = store.getSnapshot();
      if (data) games.render(data);
    }
    function expiryTick() {
      checkExpiry();
      if (cleanupDue && auth.getSession() && !store.getRecovery() && !document.querySelector("dialog[open]") && !document.getElementById("refreshButton").disabled) {
        cleanupDue = false;
        refresh();
      }
      // Check on minute boundaries: London midnight is also a UTC minute
      // boundary on both sides of a daylight-saving change. No network polling.
      window.setTimeout(expiryTick, 60000 - Date.now() % 60000);
    }
    window.setTimeout(expiryTick, 60000 - Date.now() % 60000);
    auth.init().then(function () {
      window.addEventListener("early-birds-session-change", refresh);
      // A returning player should see departures and newly filled places.
      // Coalesce focus/visibility events, and leave active forms and saves alone.
      var returnRefresh;
      function refreshOnReturn() {
        checkExpiry();
        window.clearTimeout(returnRefresh);
        returnRefresh = window.setTimeout(function () {
          var recovery = store.getRecovery();
          if (document.visibilityState !== "visible" || document.querySelector("dialog[open]") ||
              document.getElementById("refreshButton").disabled || (recovery && recovery.outcome === "uncertain")) return;
          refresh();
        }, 200);
      }
      window.addEventListener("focus", refreshOnReturn);
      document.addEventListener("visibilitychange", refreshOnReturn);
      refresh();
    });
  }

  function initHeader() {
    var button = document.getElementById("menuButton"), menu = document.getElementById("userMenu");
    function close(returnFocus) {
      menu.hidden = true; button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-label", "Open account menu");
      if (returnFocus) button.focus({ preventScroll: true });
    }
    button.addEventListener("click", function () {
      var opening = menu.hidden;
      menu.hidden = !opening; button.setAttribute("aria-expanded", String(opening));
      button.setAttribute("aria-label", opening ? "Close account menu" : "Open account menu");
    });
    document.addEventListener("click", function (event) {
      if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); close(true); }
    });
    menu.addEventListener("click", function (event) {
      if (event.target.closest("button")) close(!document.querySelector("dialog[open]"));
    });
    window.addEventListener("early-birds-session-change", function () { close(false); });
    var noticeTimers = Object.create(null);
    var progress = document.getElementById("refreshProgress"), hideProgress;
    return {
      notice: function (id, text, persistent) {
        var notice = document.getElementById(id);
        window.clearTimeout(noticeTimers[id]);
        notice.textContent = text; notice.hidden = !text;
        if (text && !persistent) noticeTimers[id] = window.setTimeout(function () { notice.hidden = true; }, 3500);
      },
      network: function (pending, saving) {
        window.clearTimeout(hideProgress);
        if (pending) {
          progress.hidden = false;
          progress.setAttribute("aria-label", saving ? "Saving shared data" : "Refreshing shared data");
        } else {
          // Let even a quick local refresh show movement without changing layout.
          hideProgress = window.setTimeout(function () { progress.hidden = true; }, 350);
        }
      },
    };
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
