/* =========================================================
   KAISOUL CHESS — engine.js
   Wraps Stockfish (Web Worker, UCI protocol).
   - Loads local js/stockfish/stockfish.js first, falls back to CDN.
   - Handles uci/isready handshake and capability detection.
   - Exposes go() with MultiPV, session tokens (anti race-condition),
     and a JS-side timeout guard.
   - Only ever runs a single Worker instance; call destroy() to clean up.
   ========================================================= */

(function (global) {
  'use strict';

  var LOCAL_SRC = 'js/stockfish/stockfish.js';
  var FALLBACK_CDN_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
  var HANDSHAKE_TIMEOUT_MS = 7000;
  var DEFAULT_SEARCH_TIMEOUT_MS = 15000;

  function KaisoulEngine() {
    this.worker = null;
    this.ready = false;
    this.failed = false;
    this.supportedOptions = {};       // name -> raw "option ..." line
    this.currentSessionId = 0;        // incremented on every go()/stop()
    this.searchTimeoutHandle = null;
    this.onFatalError = null;         // callback(message) — engine unusable
    this._activeGoCallback = null;    // {sessionId, onInfo, onBestMove}
  }

  /* ---------- lifecycle ---------- */

  KaisoulEngine.prototype.init = function () {
    var self = this;
    return new Promise(function (resolve) {
      var settled = false;

      function trySource(src, isFallback) {
        var w;
        try {
          w = new Worker(src);
        } catch (err) {
          if (!isFallback) { trySource(FALLBACK_CDN_SRC, true); }
          else { finish(false); }
          return;
        }

        var handshakeTimer = setTimeout(function () {
          if (settled) return;
          try { w.terminate(); } catch (e) {}
          if (!isFallback) { trySource(FALLBACK_CDN_SRC, true); }
          else { finish(false); }
        }, HANDSHAKE_TIMEOUT_MS);

        w.onerror = function () {
          if (settled) return;
          clearTimeout(handshakeTimer);
          try { w.terminate(); } catch (e) {}
          if (!isFallback) { trySource(FALLBACK_CDN_SRC, true); }
          else { finish(false); }
        };

        var uciOk = false;

        w.onmessage = function (e) {
          var line = typeof e.data === 'string' ? e.data : '';
          if (!line) return;

          if (!uciOk) {
            if (line.indexOf('option name') === 0) {
              self._registerOption(line);
            } else if (line.trim() === 'uciok') {
              uciOk = true;
              w.postMessage('isready');
            }
            return;
          }

          if (line.trim() === 'readyok') {
            if (settled) return;
            clearTimeout(handshakeTimer);
            self.worker = w;
            self.ready = true;
            // Hand off to the steady-state message handler.
            w.onmessage = function (ev) { self._handleSearchMessage(ev); };
            finish(true);
          }
        };

        w.postMessage('uci');
      }

      function finish(ok) {
        if (settled) return;
        settled = true;
        if (!ok) { self.failed = true; }
        resolve(ok);
      }

      trySource(LOCAL_SRC, false);
    });
  };

  KaisoulEngine.prototype._registerOption = function (line) {
    // Example: "option name Skill Level type spin default 20 min 0 max 20"
    var match = /^option name (.+?) type (\w+)/.exec(line);
    if (match) {
      this.supportedOptions[match[1]] = line;
    }
  };

  KaisoulEngine.prototype._supports = function (name) {
    return Object.prototype.hasOwnProperty.call(this.supportedOptions, name);
  };

  KaisoulEngine.prototype.destroy = function () {
    if (this.searchTimeoutHandle) { clearTimeout(this.searchTimeoutHandle); }
    this.currentSessionId++; // invalidate any in-flight callback
    this._activeGoCallback = null;
    if (this.worker) {
      try { this.worker.postMessage('quit'); } catch (e) {}
      try { this.worker.terminate(); } catch (e) {}
      this.worker = null;
    }
    this.ready = false;
  };

  /* ---------- configuration ---------- */

  KaisoulEngine.prototype.newGame = function () {
    if (!this.worker) return;
    this.worker.postMessage('ucinewgame');
    this.worker.postMessage('isready');
  };

  // Maps a 100-2500 ELO scale onto whatever strength knobs this build supports.
  KaisoulEngine.prototype.applyStrength = function (elo, speedMultiplier) {
    if (!this.worker) return { depth: 6, movetime: 500 };
    speedMultiplier = speedMultiplier || 1;

    var clampedElo = Math.max(100, Math.min(2500, elo));

    // Depth grows slowly with ELO: weak play should also blunder tactically,
    // not just move fast.
    var depth = Math.round(3 + (clampedElo / 2500) * 14); // ~4 .. 17
    depth = Math.max(2, Math.min(18, depth));

    // Thinking time scales with ELO and the user's speed preference.
    var baseMovetime = 120 + (clampedElo / 2500) * 2600; // ~220ms .. ~2700ms
    var movetime = Math.round(baseMovetime * speedMultiplier);
    movetime = Math.max(80, Math.min(6000, movetime));

    var skill = Math.round((clampedElo - 100) / (2500 - 100) * 20); // 0..20
    skill = Math.max(0, Math.min(20, skill));

    if (this._supports('MultiPV')) {
      // Reset to 1 here; go() overrides per-search when it needs candidates.
      this.worker.postMessage('setoption name MultiPV value 1');
    }

    if (this._supports('Skill Level')) {
      this.worker.postMessage('setoption name Skill Level value ' + skill);
    }

    if (this._supports('UCI_LimitStrength') && this._supports('UCI_Elo')) {
      this.worker.postMessage('setoption name UCI_LimitStrength value true');
      // Most Stockfish builds clamp UCI_Elo to roughly [1320, 3190].
      var uciElo = Math.max(1320, Math.min(3190, clampedElo));
      this.worker.postMessage('setoption name UCI_Elo value ' + uciElo);
      // If the requested ELO is below what UCI_Elo can express, compensate
      // with a shallower depth so low ratings still feel weak.
      if (clampedElo < 1320) {
        depth = Math.max(2, depth - 3);
      }
    }

    return { depth: depth, movetime: movetime };
  };

  /* ---------- search ---------- */

  // options: { fen, depth, movetime, multipv, timeoutMs }
  // onInfo(candidate): called for each MultiPV "info" line -> {multipv, move, cp, mate, pvMoves}
  // onDone(result): called exactly once -> { ok:true, bestMove, candidates } | { ok:false, reason }
  KaisoulEngine.prototype.go = function (options, onInfo, onDone) {
    var self = this;

    if (!this.worker || !this.ready) {
      onDone({ ok: false, reason: 'engine-not-ready' });
      return;
    }

    // A new search always supersedes any in-flight one. Bump the session id
    // FIRST so a late 'bestmove' from the old search is recognized as stale.
    if (this.searchTimeoutHandle) { clearTimeout(this.searchTimeoutHandle); }
    this.currentSessionId++;
    var sessionId = this.currentSessionId;
    var candidates = {}; // multipv index -> candidate info

    this._activeGoCallback = {
      sessionId: sessionId,
      onInfo: onInfo,
      onDoneRef: onDone,
      onBestMove: function (bestMoveUci, ponderUci) {
        if (self.searchTimeoutHandle) { clearTimeout(self.searchTimeoutHandle); self.searchTimeoutHandle = null; }
        var list = Object.keys(candidates)
          .sort(function (a, b) { return Number(a) - Number(b); })
          .map(function (k) { return candidates[k]; });
        onDone({ ok: true, bestMove: bestMoveUci, candidates: list });
      },
      registerInfo: function (info) {
        candidates[info.multipv] = info;
      }
    };

    var multipv = Math.max(1, Math.min(6, options.multipv || 1));
    if (this._supports('MultiPV')) {
      this.worker.postMessage('setoption name MultiPV value ' + multipv);
    }

    if (this._supports('Ponder')) {
      this.worker.postMessage('setoption name Ponder value false');
    }

    this.worker.postMessage('position fen ' + options.fen);

    var goCmd = 'go';
    if (options.depth) { goCmd += ' depth ' + options.depth; }
    if (options.movetime) { goCmd += ' movetime ' + options.movetime; }
    this.worker.postMessage(goCmd);

    var timeoutMs = options.timeoutMs || (options.movetime ? options.movetime + 5000 : DEFAULT_SEARCH_TIMEOUT_MS);
    this.searchTimeoutHandle = setTimeout(function () {
      if (self.currentSessionId !== sessionId) return; // already superseded
      self._activeGoCallback = null;
      try { self.worker.postMessage('stop'); } catch (e) {}
      onDone({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  };

  KaisoulEngine.prototype.stop = function () {
    this.currentSessionId++; // invalidate the pending callback
    var pending = this._activeGoCallback;
    this._activeGoCallback = null;
    if (this.searchTimeoutHandle) { clearTimeout(this.searchTimeoutHandle); this.searchTimeoutHandle = null; }
    if (this.worker) {
      try { this.worker.postMessage('stop'); } catch (e) {}
    }
    // A caller awaiting go() must never hang just because the search was
    // cancelled — resolve it now with a "stopped" outcome.
    if (pending && pending.onDoneRef) {
      pending.onDoneRef({ ok: false, reason: 'stopped' });
    }
  };

  KaisoulEngine.prototype._handleSearchMessage = function (e) {
    var line = typeof e.data === 'string' ? e.data : '';
    if (!line) return;

    var cb = this._activeGoCallback;
    if (!cb) return; // nothing is listening right now

    if (line.indexOf('info') === 0 && line.indexOf(' pv ') !== -1) {
      var mpvMatch = /multipv (\d+)/.exec(line);
      var cpMatch = /score cp (-?\d+)/.exec(line);
      var mateMatch = /score mate (-?\d+)/.exec(line);
      var pvMatch = /\bpv (.+)$/.exec(line);
      if (pvMatch) {
        var pvMoves = pvMatch[1].trim().split(/\s+/);
        var info = {
          multipv: mpvMatch ? Number(mpvMatch[1]) : 1,
          move: pvMoves[0],
          pvMoves: pvMoves,
          cp: cpMatch ? Number(cpMatch[1]) : null,
          mate: mateMatch ? Number(mateMatch[1]) : null
        };
        cb.registerInfo(info);
        if (cb.onInfo) { cb.onInfo(info); }
      }
      return;
    }

    if (line.indexOf('bestmove') === 0) {
      // Only honor this if it belongs to the current session.
      if (this.currentSessionId !== cb.sessionId) { return; }
      var parts = line.split(/\s+/);
      var best = parts[1] || null;
      var ponder = parts[3] || null;
      this._activeGoCallback = null;
      if (best === '(none)') { best = null; }
      cb.onBestMove(best, ponder);
    }
  };

  global.KaisoulEngine = KaisoulEngine;
})(typeof window !== 'undefined' ? window : this);
