(function () {
  "use strict";

  var config = window.EarlyBirdsConfig;
  var keys = config.storageKeys;
  var session = null;
  var users = [];
  var generation = 0;
  var busy = false;
  var controller;
  var el = {};
  var codes = new Map();

  function init() {
    ["signInButton", "profileButton", "signOutButton", "authStatus", "authError",
      "profileDialog", "profileForm", "profileTitle", "profileDescription", "profileUser",
      "profileToken", "profileAdmin", "reloadUsersButton", "profileStatus", "profileError",
      "saveProfileButton", "cancelProfileButton"].forEach(function (id) { el[id] = document.getElementById(id); });
    el.signInButton.addEventListener("click", openProfile);
    el.profileButton.addEventListener("click", openProfile);
    el.signOutButton.addEventListener("click", signOut);
    el.profileForm.addEventListener("submit", submitProfile);
    el.cancelProfileButton.addEventListener("click", function () { el.profileDialog.close(); });
    el.profileDialog.addEventListener("close", function () {
      cancelVerification();
      el.profileToken.value = "";
      setBusy(false);
    });
    el.reloadUsersButton.addEventListener("click", loadUsers);
    window.addEventListener("storage", function (event) {
      if (event.key === null || [keys.token, keys.userId, keys.adminMode].indexOf(event.key) >= 0) {
        restoreSession();
      }
    });
    renderSession();
    loadUsers();
  }

  function activeUser(id) {
    return users.find(function (user) { return user.id === id && user.active; });
  }

  function setUsers(directory) {
    if (!directory || directory.version !== config.schemaVersion || !Array.isArray(directory.users)) {
      throw new Error("Invalid player directory");
    }
    var ids = new Set();
    var next = directory.users.map(function (user) {
      if (!user || typeof user.id !== "string" || !user.id || ids.has(user.id) ||
        typeof user.name !== "string" || !user.name.trim() || typeof user.active !== "boolean") {
        throw new Error("Invalid player directory");
      }
      ids.add(user.id);
      return { id: user.id, name: user.name.trim(), active: user.active };
    });
    users = next.sort(function (a, b) { return a.name.localeCompare(b.name) || a.id.localeCompare(b.id); });
    var selected = el.profileUser.value;
    el.profileUser.replaceChildren(new Option("Choose your name", ""));
    users.filter(function (user) { return user.active; }).forEach(function (user) {
      el.profileUser.add(new Option(user.name, user.id));
    });
    el.profileUser.value = activeUser(selected) ? selected : "";
    el.profileUser.disabled = !users.some(function (user) { return user.active; });
    if (session && !activeUser(session.userId)) {
      signOut();
      el.authError.textContent = "Your player profile is no longer active. Contact an organiser.";
    }
    setBusy(busy);
    renderSession();
  }

  async function loadUsers() {
    el.reloadUsersButton.hidden = true;
    el.profileStatus.textContent = "Loading players…";
    el.profileError.textContent = "";
    try {
      var response = await fetch(config.github.usersPath, { cache: "no-store" });
      if (!response.ok) throw new Error("Player load failed");
      setUsers(await response.json());
      el.profileStatus.textContent = "";
      if (el.profileUser.disabled) el.profileError.textContent = "No active players. Contact an organiser.";
      await restoreSession();
    } catch (_) {
      el.reloadUsersButton.hidden = false;
      el.profileStatus.textContent = "";
      el.profileError.textContent = "Could not load players. Retry loading players to sign in.";
    }
  }

  function cancelVerification() {
    generation += 1;
    if (controller) controller.abort();
  }

  async function verifyToken(token) {
    var tokenController = new AbortController();
    controller = tokenController;
    var timer = window.setTimeout(function () { tokenController.abort(); }, 10000);
    try {
      var response = await fetch("https://api.github.com/repos/" +
        encodeURIComponent(config.github.owner) + "/" + encodeURIComponent(config.github.repo), {
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token },
        cache: "no-store", signal: tokenController.signal,
      });
      if (response.status === 401) throw new Error("The token is invalid or expired. Check it and try again.");
      if (response.status === 403 || response.status === 429) throw new Error("GitHub denied the check or is rate limiting requests. Check token access or try again later.");
      if (!response.ok) throw new Error("Could not access the Early Birds repository. Check token access and try again.");
      // A read check validates the credential, not Contents write permission.
      // GitHub will enforce that permission when shared-data writes are added.
    } catch (error) {
      if (error instanceof TypeError || error.name === "AbortError") {
        throw new Error("Could not check the token. Check your connection and try again.");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function setBusy(value) {
    busy = value;
    var noActiveUsers = !users.some(function (user) { return user.active; });
    el.profileUser.disabled = value || noActiveUsers;
    el.profileToken.disabled = value;
    el.profileAdmin.disabled = value;
    el.saveProfileButton.disabled = value || noActiveUsers;
    el.profileForm.setAttribute("aria-busy", String(value));
  }

  function openProfile() {
    cancelVerification();
    setBusy(false);
    el.profileTitle.textContent = session ? "My profile" : "Sign in";
    el.saveProfileButton.textContent = session ? "Save profile" : "Sign in";
    el.profileUser.value = session ? session.userId : "";
    el.profileAdmin.checked = Boolean(session && session.isAdmin);
    el.profileToken.value = "";
    el.profileToken.required = !session;
    el.profileToken.placeholder = session ? "Leave blank to keep your current token" : "Paste your GitHub token";
    el.profileStatus.textContent = "";
    // Preserve a player-loading error and its retry control.
    if (el.reloadUsersButton.hidden) el.profileError.textContent = "";
    if (!el.profileDialog.open) el.profileDialog.showModal();
  }

  async function submitProfile(event) {
    event.preventDefault();
    if (busy) return;
    var userId = el.profileUser.value;
    var token = el.profileToken.value.trim() || (session ? session.token : "");
    var isAdmin = el.profileAdmin.checked;
    if (!activeUser(userId) || !token) {
      el.profileError.textContent = "Choose an active player and paste a GitHub token.";
      return;
    }
    cancelVerification();
    var attempt = generation;
    setBusy(true);
    el.profileError.textContent = "";
    el.profileStatus.textContent = "Checking token with GitHub…";
    try {
      await verifyToken(token);
      if (attempt !== generation) return;
      if (!activeUser(userId)) throw new Error("That player is no longer active. Choose another name.");
      session = { userId: userId, token: token, isAdmin: isAdmin };
      var saved = persistSession();
      el.profileDialog.close();
      renderSession();
      el.authStatus.textContent = saved ? "Signed in. Profile saved in this browser." : "Signed in for this visit only.";
      el.authError.textContent = saved ? "" : "Browser storage is unavailable. Your profile may not be restored after a refresh.";
      el.profileButton.focus();
    } catch (error) {
      if (attempt === generation) {
        el.profileStatus.textContent = "";
        el.profileError.textContent = error.message;
      }
    } finally {
      if (attempt === generation) setBusy(false);
    }
  }

  function clearStoredSession() {
    var success = true;
    [keys.token, keys.userId, keys.adminMode].forEach(function (key) {
      try { window.localStorage.removeItem(key); } catch (_) { success = false; }
    });
    return success;
  }

  function persistSession() {
    try {
      window.localStorage.setItem(keys.token, session.token);
      window.localStorage.setItem(keys.userId, session.userId);
      window.localStorage.setItem(keys.adminMode, String(session.isAdmin));
      return true;
    } catch (_) {
      clearStoredSession();
      return false;
    }
  }

  async function restoreSession() {
    cancelVerification();
    var attempt = generation;
    session = null;
    renderSession();
    el.authStatus.textContent = "";
    el.authError.textContent = "";
    try {
      var token = window.localStorage.getItem(keys.token);
      var userId = window.localStorage.getItem(keys.userId);
      if (!token || !activeUser(userId)) { clearStoredSession(); return; }
      var isAdmin = window.localStorage.getItem(keys.adminMode) === "true";
      el.authStatus.textContent = "Checking saved sign-in…";
      await verifyToken(token);
      if (attempt !== generation) return;
      if (!activeUser(userId)) { clearStoredSession(); return; }
      session = { token: token, userId: userId, isAdmin: isAdmin };
      renderSession();
      el.authStatus.textContent = "";
    } catch (_) {
      if (attempt === generation) {
        el.authStatus.textContent = "";
        el.authError.textContent = "Could not restore sign-in. Sign in again to check your token and connection.";
      }
    }
  }

  function signOut() {
    cancelVerification();
    session = null;
    var cleared = clearStoredSession();
    el.profileToken.value = "";
    if (el.profileDialog.open) el.profileDialog.close();
    renderSession();
    el.authStatus.textContent = "Signed out.";
    el.authError.textContent = cleared ? "" : "Could not clear saved sign-in. Clear this site's browser data before leaving a shared device.";
    el.signInButton.focus();
  }

  function renderSession() {
    window.EarlyBirdsUI.setAccess({ signedIn: Boolean(session), isAdmin: Boolean(session && session.isAdmin) });
    var user = session && activeUser(session.userId);
    el.sessionSummary = document.getElementById("sessionSummary");
    el.sessionSummary.textContent = user ? user.name + (session.isAdmin ? " · Admin" : "") : "Visitor";
    el.signInButton.hidden = Boolean(session);
    el.profileButton.hidden = !session;
    el.signOutButton.hidden = !session;
    codes.forEach(function (code, element) {
      if (!element.isConnected) { codes.delete(element); return; }
      showCode(element, code);
    });
    window.dispatchEvent(new CustomEvent("early-birds-session-change"));
  }

  function requireWrite(options) {
    if (session && activeUser(session.userId) && (!(options && options.admin) || session.isAdmin)) return true;
    el.authError.textContent = session ? "Choose Admin mode in My profile to make this change." : "Sign in with a GitHub token to make changes.";
    openProfile();
    el.profileError.textContent = el.authError.textContent;
    return false;
  }

  function showCode(element, code) {
    element.textContent = session ? "*" + String(code).replace(/^\*+/, "") : "Sign in with a token to see the code";
    element.classList.toggle("masked-code", !session);
  }

  window.EarlyBirdsAuth = Object.freeze({
    init: init,
    setUsers: setUsers,
    getSession: function () { return session ? Object.assign({}, session) : null; },
    requireWrite: requireWrite,
    renderCourtCode: function (element, code) { codes.set(element, code); showCode(element, code); },
  });
})();
