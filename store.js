(function (root) {
  "use strict";
  function createStore(options) {
    var config = options.config;
    var model = options.model;
    var github = config.github;
    var snapshot = null;
    var queue = Promise.resolve();
    var listeners = new Set();
    var recovery = null;
    var save = { outcome: "none", message: "" };
    var stale = false;
    var cleanup = { outcome: "none", message: "" };
    var status = { phase: "idle", message: "", source: "" };
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function current() { return options.getSession(); }
    function sameActor(actor) {
      var live = current();
      return actor ? live && actor.userId === live.userId && actor.token === live.token && actor.isAdmin === live.isAdmin : !live;
    }
    function assertActor(actor) { if (!sameActor(actor)) throw new Error("Sign-in changed. Refresh before trying again."); }
    function notify() {
      var view = copy(status);
      view.stale = stale;
      view.cleanup = copy(cleanup);
      view.save = Object.assign({}, save, { canRetry: Boolean(recovery && current() && current().userId === recovery.userId &&
        current().isAdmin === recovery.isAdmin && save.outcome !== "pending") });
      listeners.forEach(function (listener) { listener({ status: copy(view), data: copy(snapshot) }); });
    }
    function setStatus(phase, message, source) { status = { phase: phase, message: message, source: source || status.source }; notify(); }
    function enqueue(work) {
      var result = queue.then(work);
      queue = result.catch(function () {});
      return result;
    }
    function fault(message, code) { var error = new Error(message); error.code = code; return error; }
    function url(file) {
      return "https://api.github.com/repos/" + encodeURIComponent(github.owner) + "/" + encodeURIComponent(github.repo) +
        "/contents/" + file.split("/").map(encodeURIComponent).join("/");
    }
    async function request(target, actor, init) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 10000);
      try {
        var response = await options.fetch(target, Object.assign({}, init, { cache: "no-store", signal: controller.signal }));
        if (!response.ok) {
          if (response.status === 401) throw fault("The GitHub token is invalid or expired. Sign in again.", 401);
          if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
            throw fault("GitHub is rate limiting requests. Wait before retrying.", 429);
          }
          if (response.status === 403) throw fault("GitHub denied access. Check the token's repository selection and Contents: Read and write permission.", 403);
          if (response.status === 404) throw fault("Shared files were not found. Check the repository/branch and publish the initial data files before saving.", 404);
          if (response.status === 409) throw fault("Shared data changed while saving.", 409);
          throw fault("GitHub could not complete the request. No save has been confirmed.", response.status);
        }
        try { return await response.json(); } catch (_) { throw fault("Shared response is not valid JSON. No save has been confirmed.", "response"); }
      } catch (error) {
        if (error.code) throw error;
        throw fault("Could not reach shared data. Check your connection and retry; a save may need confirmation.", "network");
      } finally { clearTimeout(timer); }
    }
    function headers(actor) {
      var value = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      if (actor) value.Authorization = "Bearer " + actor.token;
      return value;
    }
    function decode(content) {
      try {
        var bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), function (c) { return c.charCodeAt(0); });
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (_) { throw fault("Shared data could not be decoded. Review it before saving.", "data"); }
    }
    function encode(data) {
      var bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + "\n");
      var binary = ""; bytes.forEach(function (byte) { binary += String.fromCharCode(byte); });
      return btoa(binary);
    }
    async function read(file, actor, forceGithub) {
      if (options.isLocal && !actor && !forceGithub) return { data: await request(file, null, {}), sha: null };
      var result = await request(url(file) + "?ref=" + encodeURIComponent(github.branch), actor, { headers: headers(actor) });
      if (!result || result.type !== "file" || result.encoding !== "base64" || typeof result.content !== "string" || typeof result.sha !== "string" || !result.sha) {
        throw fault("Shared data has an unsupported file format. Review it before saving.", "data");
      }
      return { data: decode(result.content), sha: result.sha };
    }
    async function readPair(actor, forceGithub) {
      var files = await Promise.all([read(github.usersPath, actor, forceGithub), read(github.statePath, actor, forceGithub)]);
      var directory = model.validateUsers(files[0].data);
      var state = model.validateState(files[1].data, directory);
      return { users: directory, state: state, usersSha: files[0].sha, stateSha: files[1].sha };
    }
    async function loadDirectory() {
      return model.validateUsers((await read(github.usersPath, current(), false)).data);
    }
    function nowIso() { return (options.now ? options.now() : new Date()).toISOString(); }
    function hasExpired(pair, now) {
      var today = model.londonClock(now).date;
      return pair.state.courts.some(function (court) { return court.date < today; });
    }
    async function cleanupExpired(actor, pair) {
      cleanup = { outcome: "none", message: "" };
      if (!actor || !hasExpired(pair, nowIso())) return pair;
      // Automatic maintenance must never replace a player's retained intent.
      if (recovery) {
        cleanup = { outcome: "deferred", message: "Old courts are hidden. Cleanup will wait until your retained change is resolved." };
        return pair;
      }
      var uncertain = false;
      try {
        for (var attempt = 0; attempt < 4; attempt += 1) {
          assertActor(actor);
          if (attempt) pair = await readPair(actor, true);
          assertActor(actor);
          var now = nowIso();
          var next = model.applyState(pair.state, pair.users, { type: "courts.cleanup" }, actor, now);
          if (JSON.stringify(next) === JSON.stringify(pair.state)) {
            cleanup = { outcome: "saved", message: "Expired courts removed from shared data." };
            return pair;
          }
          next.updatedAt = now; next.updatedBy = actor.userId;
          model.validateState(next, pair.users);
          var directory = await read(github.usersPath, actor, true);
          if (directory.sha !== pair.usersSha) continue;
          assertActor(actor);
          var acknowledgement;
          try {
            acknowledgement = await request(url(github.statePath), actor, {
              method: "PUT", headers: Object.assign(headers(actor), { "Content-Type": "application/json" }),
              body: JSON.stringify({ branch: github.branch, sha: pair.stateSha, content: encode(next), message: "Remove expired Early Birds courts" }),
            });
          } catch (error) {
            if (error.code === 409) continue;
            if (error.code === "network" || error.code === "response" || error.code >= 500) { uncertain = true; continue; }
            throw error;
          }
          if (!acknowledgement || !acknowledgement.content || typeof acknowledgement.content.sha !== "string" || !acknowledgement.content.sha) { uncertain = true; continue; }
          assertActor(actor);
          pair.state = next; pair.stateSha = acknowledgement.content.sha;
          cleanup = { outcome: "saved", message: "Expired courts removed from shared data." };
          return pair;
        }
        throw fault("Shared data kept changing.", "conflict");
      } catch (error) {
        cleanup = { outcome: "failed", message: "Old courts are hidden, but cleanup " + (uncertain ? "is not confirmed" : "could not be saved") + ". Refresh to try again. " + error.message };
        return pair;
      }
    }
    function refresh() {
      return enqueue(async function () {
        var actor = current();
        setStatus("loading", "Refreshing shared data…");
        try {
          var pair = await readPair(actor, false);
          assertActor(actor);
          pair = await cleanupExpired(actor, pair);
          assertActor(actor);
          snapshot = pair;
          stale = false;
          setStatus("ready", "Data refreshed.", options.isLocal && !actor ? "local" : "github");
          return copy(snapshot);
        } catch (error) {
          stale = Boolean(snapshot);
          setStatus("error", error.message);
          throw error;
        }
      });
    }
    function mutate(action, isRetry) {
      // Capture intent now. Never queue an entire stale document for replacement.
      var intent = copy(action);
      var actor = current();
      if (!options.requireWrite()) return Promise.reject(fault("Sign in with a GitHub token to make changes.", "auth"));
      var userAction = intent.type === "user.add" || intent.type === "user.patch";
      return enqueue(async function () {
        var uncertain = Boolean(isRetry && recovery && save.outcome === "uncertain");
        var confirmed = false;
        recovery = { action: intent, userId: actor.userId, isAdmin: actor.isAdmin };
        save = { outcome: "pending", message: isRetry ? "Retrying your change…" : "Saving your change…" };
        setStatus("saving", "Saving change…");
        try {
          for (var attempt = 0; attempt < 4; attempt += 1) {
            assertActor(actor);
            var pair = await readPair(actor, true);
            assertActor(actor);
            var now = nowIso();
            var original = userAction ? pair.users : pair.state;
            var next = userAction ? model.applyUsers(pair.users, intent, actor) : model.applyState(pair.state, pair.users, intent, actor, now);
            if (!userAction) next = model.applyState(next, pair.users, { type: "courts.cleanup" }, actor, now);
            if (JSON.stringify(next) === JSON.stringify(original)) {
              snapshot = pair;
              stale = false;
              recovery = null;
              if (userAction) { snapshot = await cleanupExpired(actor, pair); assertActor(actor); }
              else cleanup = { outcome: "none", message: "" };
              save = { outcome: "saved", message: "Change confirmed in shared data." };
              setStatus("ready", "Change confirmed; shared data is up to date.", "github");
              return copy(snapshot);
            }
            next.updatedAt = now; next.updatedBy = actor.userId;
            if (userAction) model.validateUsers(next); else model.validateState(next, pair.users);
            // Recheck the separate directory immediately before PUT. GitHub does
            // not provide an atomic transaction across the users and state files.
            var directoryCheck = await read(github.usersPath, actor, true);
            if (directoryCheck.sha !== pair.usersSha) continue;
            assertActor(actor);
            var file = userAction ? github.usersPath : github.statePath;
            var sha = userAction ? pair.usersSha : pair.stateSha;
            var acknowledgement;
            try {
              acknowledgement = await request(url(file), actor, {
                method: "PUT", headers: Object.assign(headers(actor), { "Content-Type": "application/json" }),
                body: JSON.stringify({ branch: github.branch, sha: sha, content: encode(next), message: userAction ? "Update Early Birds players" : "Update Early Birds games" }),
              });
            } catch (error) {
              // Unknown acknowledgement (timeout/5xx) is reconciled by reading
              // again and replaying the same IDs, never by blindly repeating PUT.
              if (error.code === "network" || error.code === "response" || error.code >= 500) { uncertain = true; continue; }
              if (error.code === 409) continue;
              throw error;
            }
            if (!acknowledgement || !acknowledgement.content || typeof acknowledgement.content.sha !== "string") {
              // A malformed success response is also an uncertain acknowledgement.
              uncertain = true;
              continue;
            }
            confirmed = true;
            assertActor(actor);
            if (userAction) { pair.users = next; pair.usersSha = acknowledgement.content.sha; }
            else { pair.state = next; pair.stateSha = acknowledgement.content.sha; }
            snapshot = pair;
            stale = false;
            recovery = null;
            if (userAction) { snapshot = await cleanupExpired(actor, pair); assertActor(actor); }
            else cleanup = { outcome: "none", message: "" };
            save = { outcome: "saved", message: "Change saved." };
            setStatus("ready", "Change saved.", "github");
            return copy(snapshot);
          }
          throw fault("Could not confirm the change after concurrent updates. Refresh and retry the same action.", "conflict");
        } catch (error) {
          stale = Boolean(snapshot);
          if (confirmed) {
            recovery = null;
            save = { outcome: "saved", message: "Change saved before sign-in changed. Refresh to see the latest data." };
          } else {
            save = { outcome: uncertain ? "uncertain" : "failed", message: uncertain ?
              "Save not confirmed. It may have reached GitHub. Retry the same change to check safely." :
              "Change not saved. Your change is kept in this tab for retry." };
          }
          setStatus("error", error.message);
          error.outcome = save.outcome;
          throw error;
        }
      });
    }
    return Object.freeze({
      loadDirectory: loadDirectory, refresh: refresh, mutate: mutate,
      retry: function () {
        var actor = current();
        if (!recovery || save.outcome === "pending" || !actor || actor.userId !== recovery.userId || actor.isAdmin !== recovery.isAdmin) {
          return Promise.reject(fault("Sign in as the original player with the same Admin mode to retry this change.", "auth"));
        }
        return mutate(recovery.action, true);
      },
      getRecovery: function () { return recovery ? { action: copy(recovery.action), outcome: save.outcome } : null; },
      getSnapshot: function () { return copy(snapshot); },
      subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    });
  }
  if (typeof module === "object" && module.exports) module.exports = createStore;
  else root.createEarlyBirdsStore = createStore;
})(typeof window === "undefined" ? globalThis : window);
