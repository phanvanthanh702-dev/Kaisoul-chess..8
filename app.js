/* =========================================================
   KAISOUL CHESS — app.js
   Screens, board rendering, gameplay, AI orchestration,
   settings, puzzles, error handling, PWA registration.
   ========================================================= */

/* ---------------------------------------------------------
   0. GLOBAL ERROR HANDLING — must be first, must never depend
      on anything that could itself fail.
   --------------------------------------------------------- */
(function () {
  function showFatal(msg) {
    var overlay = document.getElementById('fatalErrorOverlay');
    var msgEl = document.getElementById('fatalErrorMessage');
    if (!overlay) { return; } // truly nothing we can do
    if (msgEl) { msgEl.textContent = msg || 'Đã có lỗi không mong muốn xảy ra.'; }
    overlay.classList.remove('hidden');
  }
  window.__kaisoulShowFatal = showFatal;

  window.addEventListener('error', function (e) {
    console.error('KAISOUL fatal error:', e.error || e.message);
    showFatal('Đã xảy ra lỗi: ' + (e.message || 'không xác định'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    console.error('KAISOUL unhandled rejection:', e.reason);
    showFatal('Đã xảy ra lỗi khi xử lý dữ liệu.');
  });

  document.addEventListener('DOMContentLoaded', function () {
    var retryBtn = document.getElementById('fatalErrorRetryBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () { window.location.reload(); });
    }
  });
})();

/* ---------------------------------------------------------
   The rest of the app runs inside try/catch so a mistake
   during boot shows the friendly overlay instead of a blank
   white screen.
   --------------------------------------------------------- */
try {

  if (window.__CHESSJS_FAILED__ || typeof Chess === 'undefined') {
    window.__kaisoulShowFatal('Không thể tải thư viện luật cờ (Chess.js). Vui lòng kiểm tra kết nối mạng và thử lại.');
    throw new Error('Chess.js failed to load');
  }

  /* ---------------------------------------------------------
     1. CONSTANTS & DOM HELPERS
     --------------------------------------------------------- */
  var ELO_STEPS = [100, 300, 500, 700, 900, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  var PIECE_UNICODE = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
  };
  var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  var SPEED_MULTIPLIER = { fast: 0.5, normal: 1, deep: 2.2 };

  function $(id) { return document.getElementById(id); }
  function positionKey(fen) { return fen.split(' ').slice(0, 4).join(' '); }

  /* ---------------------------------------------------------
     2. STATE
     --------------------------------------------------------- */
  var state = {
    settings: loadSettings(),
    game: null,               // Chess instance for the active game
    gameMode: null,           // 'ai' | '2p'
    playerColor: 'w',
    aiElo: 1000,
    engine: null,             // KaisoulEngine instance (lazy)
    engineReadyPromise: null,
    thinking: false,
    selected: null,
    legalTargets: [],
    lastMove: null,
    positionHistoryKeys: [],
    redoStack: [],
    gameOver: false,
    pendingPromotion: null,   // {from, to}
    puzzles: buildPuzzleData(),
    puzzleIndex: 0,
    puzzleScore: 0,
    puzzleGame: null,
    puzzleLocked: false,
    drag: null                // active pointer-drag info
  };

  /* ---------------------------------------------------------
     3. SETTINGS & HISTORY (localStorage)
     --------------------------------------------------------- */
  function loadSettings() {
    var defaults = {
      darkMode: true,
      sound: true,
      animation: true,
      showLegal: true,
      showCoords: true,
      aiSpeed: 'normal'
    };
    try {
      var raw = localStorage.getItem('kaisoul_settings');
      if (!raw) return defaults;
      var parsed = JSON.parse(raw);
      return Object.assign(defaults, parsed);
    } catch (e) {
      return defaults;
    }
  }

  function saveSettings() {
    try { localStorage.setItem('kaisoul_settings', JSON.stringify(state.settings)); } catch (e) { /* storage full/unavailable: ignore */ }
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem('kaisoul_history');
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function pushHistory(entry) {
    var list = loadHistory();
    list.unshift(entry);
    if (list.length > 30) { list = list.slice(0, 30); }
    try { localStorage.setItem('kaisoul_history', JSON.stringify(list)); } catch (e) { /* ignore */ }
    renderHistoryList();
  }

  function clearHistory() {
    try { localStorage.removeItem('kaisoul_history'); } catch (e) { /* ignore */ }
    renderHistoryList();
  }

  /* ---------------------------------------------------------
     4. SOUND (tiny synthesized beeps — no asset files needed)
     --------------------------------------------------------- */
  var audioCtx = null;
  function playTone(freq, durationMs) {
    if (!state.settings.sound) return;
    try {
      if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch (e) { /* audio not available: silently ignore */ }
  }
  function soundMove() { playTone(440, 90); }
  function soundCapture() { playTone(300, 110); }
  function soundCheck() { playTone(600, 160); }
  function soundGameOver() { playTone(220, 260); }

  /* ---------------------------------------------------------
     5. SCREEN NAVIGATION
     --------------------------------------------------------- */
  var screenStack = ['menu'];

  function goToScreen(name, opts) {
    opts = opts || {};
    document.querySelectorAll('.screen').forEach(function (el) { el.classList.remove('active'); });
    var target = $('screen-' + name);
    if (target) { target.classList.add('active'); }
    else { $('screen-menu').classList.add('active'); name = 'menu'; }

    if (!opts.replace) { screenStack.push(name); }
    else { screenStack[screenStack.length - 1] = name; }

    $('backBtn').classList.toggle('hidden', name === 'menu');
    var titles = {
      menu: 'KAISOUL CHESS', 'setup-ai': 'Chơi với máy', game: 'Ván đấu',
      'setup-2p': 'Hai người chơi', puzzle: 'Puzzle', guide: 'Hướng dẫn', settings: 'Cài đặt'
    };
    $('headerTitle').textContent = titles[name] || 'KAISOUL CHESS';
  }

  function goBack() {
    // Leaving an active game: confirm and clean up the engine search.
    var current = screenStack[screenStack.length - 1];
    if (current === 'game' && !state.gameOver) {
      askConfirm('Rời khỏi ván đấu?', 'Ván đấu hiện tại sẽ không được lưu.', function () {
        if (state.engine) { state.engine.stop(); }
        screenStack.pop();
        goToScreen(screenStack.pop() || 'menu', { replace: true });
      });
      return;
    }
    screenStack.pop();
    var prev = screenStack.pop() || 'menu';
    goToScreen(prev, { replace: true });
  }

  /* ---------------------------------------------------------
     6. GENERIC CONFIRM MODAL
     --------------------------------------------------------- */
  var confirmYesHandler = null;
  function askConfirm(title, desc, onYes) {
    $('confirmTitle').textContent = title;
    $('confirmDesc').textContent = desc;
    confirmYesHandler = onYes;
    $('confirmModal').classList.remove('hidden');
  }
  $('confirmYesBtn').addEventListener('click', function () {
    $('confirmModal').classList.add('hidden');
    if (confirmYesHandler) { var h = confirmYesHandler; confirmYesHandler = null; h(); }
  });
  $('confirmNoBtn').addEventListener('click', function () {
    $('confirmModal').classList.add('hidden');
    confirmYesHandler = null;
  });

  /* ---------------------------------------------------------
     7. BOARD RENDERING
     --------------------------------------------------------- */
  function squareName(file, rank) { return FILES[file] + rank; }

  function renderBoard(boardEl, game, orientationWhite, opts) {
    opts = opts || {};
    boardEl.innerHTML = '';
    boardEl.classList.toggle('no-anim', !state.settings.animation);

    var board = game.board(); // row0 = rank8 ... row7 = rank1
    for (var displayRow = 0; displayRow < 8; displayRow++) {
      for (var displayCol = 0; displayCol < 8; displayCol++) {
        var rowIdx = orientationWhite ? displayRow : 7 - displayRow;
        var colIdx = orientationWhite ? displayCol : 7 - displayCol;
        var rank = 8 - rowIdx;
        var file = colIdx;
        var sqName = squareName(file, rank);
        var isLight = (rowIdx + colIdx) % 2 === 0;

        var sqEl = document.createElement('div');
        sqEl.className = 'sq ' + (isLight ? 'sq-light' : 'sq-dark');
        sqEl.dataset.square = sqName;
        sqEl.setAttribute('role', 'gridcell');

        if (opts.selected === sqName) { sqEl.classList.add('selected'); }
        if (opts.lastMove && (opts.lastMove.from === sqName || opts.lastMove.to === sqName)) {
          sqEl.classList.add('last-move');
        }
        if (opts.checkSquare === sqName) { sqEl.classList.add('in-check'); }

        var cell = board[rowIdx][colIdx];
        if (cell) {
          var pieceEl = document.createElement('span');
          pieceEl.className = 'piece piece-' + (cell.color === 'w' ? 'white' : 'black');
          pieceEl.textContent = PIECE_UNICODE[cell.color][cell.type];
          pieceEl.dataset.square = sqName;
          pieceEl.dataset.color = cell.color;
          sqEl.appendChild(pieceEl);
        }

        if (state.settings.showLegal && opts.legalTargets && opts.legalTargets.indexOf(sqName) !== -1) {
          var marker = document.createElement('div');
          marker.className = cell ? 'move-ring' : 'move-dot';
          sqEl.appendChild(marker);
        }

        boardEl.appendChild(sqEl);
      }
    }

    renderCoords(orientationWhite);
  }

  function renderCoords(orientationWhite) {
    if (!state.settings.showCoords) {
      $('coordsFilesTop').classList.add('hidden');
      $('coordsFilesBottom').classList.add('hidden');
      $('coordsRanks').classList.add('hidden');
      return;
    }
    var files = orientationWhite ? FILES.slice() : FILES.slice().reverse();
    var ranks = orientationWhite ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    $('coordsFilesBottom').innerHTML = files.map(function (f) { return '<span>' + f + '</span>'; }).join('');
    $('coordsFilesBottom').classList.remove('hidden');
    $('coordsFilesTop').classList.add('hidden');
    $('coordsRanks').innerHTML = ranks.map(function (r) { return '<span>' + r + '</span>'; }).join('');
    $('coordsRanks').classList.remove('hidden');
  }

  function currentCheckSquare(game) {
    if (!game.in_check()) return null;
    var turn = game.turn();
    var board = game.board();
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var cell = board[r][c];
        if (cell && cell.type === 'k' && cell.color === turn) {
          return squareName(c, 8 - r);
        }
      }
    }
    return null;
  }

  function renderMainBoard() {
    var orientationWhite = state.gameMode === '2p' ? true : (state.playerColor === 'w');
    renderBoard($('chessboard'), state.game, orientationWhite, {
      selected: state.selected,
      legalTargets: state.legalTargets,
      lastMove: state.lastMove,
      checkSquare: currentCheckSquare(state.game)
    });
  }

  /* ---------------------------------------------------------
     8. PLAYER INTERACTION (tap + pointer drag)
     --------------------------------------------------------- */
  function isPlayerTurn() {
    if (state.gameOver || state.thinking) return false;
    if (state.gameMode === '2p') return true;
    return state.game.turn() === state.playerColor;
  }

  function clearSelection() {
    state.selected = null;
    state.legalTargets = [];
  }

  function onSquareTap(sqName) {
    if (!isPlayerTurn()) return;

    if (state.selected) {
      if (state.legalTargets.indexOf(sqName) !== -1) {
        tryPlayerMove(state.selected, sqName);
        return;
      }
      var pieceAtTarget = state.game.get(sqName);
      if (pieceAtTarget && pieceAtTarget.color === state.game.turn()) {
        selectSquare(sqName);
      } else {
        clearSelection();
        renderMainBoard();
      }
      return;
    }
    selectSquare(sqName);
  }

  function selectSquare(sqName) {
    var piece = state.game.get(sqName);
    if (!piece || piece.color !== state.game.turn()) { clearSelection(); renderMainBoard(); return; }
    var moves = state.game.moves({ square: sqName, verbose: true });
    if (moves.length === 0) { clearSelection(); renderMainBoard(); return; }
    state.selected = sqName;
    state.legalTargets = moves.map(function (m) { return m.to; });
    renderMainBoard();
  }

  function tryPlayerMove(from, to) {
    var moves = state.game.moves({ square: from, verbose: true });
    var matches = moves.filter(function (m) { return m.to === to; });
    if (matches.length === 0) { clearSelection(); renderMainBoard(); return; }

    var needsPromotion = matches.some(function (m) { return m.flags.indexOf('p') !== -1; });
    if (needsPromotion) {
      state.pendingPromotion = { from: from, to: to };
      openPromotionModal(state.game.turn());
      return;
    }
    finalizePlayerMove(from, to, null);
  }

  function finalizePlayerMove(from, to, promotion) {
    var moveObj = { from: from, to: to };
    if (promotion) { moveObj.promotion = promotion; }
    var result = state.game.move(moveObj);
    clearSelection();
    if (!result) { renderMainBoard(); return; } // shouldn't happen; guard anyway

    applyPostMoveEffects(result);

    if (state.gameMode === 'ai' && !state.gameOver) {
      renderMainBoard();
      updateStatus();
      setTimeout(requestAiMove, 260);
    } else {
      renderMainBoard();
      updateStatus();
    }
  }

  /* ---------- pointer drag-and-drop ---------- */
  var boardEl = $('chessboard');
  boardEl.addEventListener('pointerdown', function (e) {
    var pieceEl = e.target.closest ? e.target.closest('.piece') : null;
    var sqEl = e.target.closest ? e.target.closest('.sq') : null;
    if (!sqEl) return;
    var sqName = sqEl.dataset.square;

    if (!isPlayerTurn()) { return; }

    if (pieceEl && pieceEl.dataset.color === state.game.turn()) {
      onSquareTap(sqName); // selects + shows legal targets
      startDrag(pieceEl, sqName, e);
    } else if (state.selected) {
      onSquareTap(sqName);
    }
  });

  function startDrag(pieceEl, fromSquare, e) {
    state.drag = { pieceEl: pieceEl, from: fromSquare, startX: e.clientX, startY: e.clientY, moved: false };
    pieceEl.setPointerCapture && pieceEl.setPointerCapture(e.pointerId);
    pieceEl.classList.add('dragging');

    function onMove(ev) {
      if (!state.drag) return;
      var dx = ev.clientX - state.drag.startX;
      var dy = ev.clientY - state.drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { state.drag.moved = true; }
      pieceEl.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.15)';
      pieceEl.style.zIndex = '5';
    }
    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      pieceEl.classList.remove('dragging');
      pieceEl.style.transform = '';
      pieceEl.style.zIndex = '';
      if (!state.drag) return;
      var wasMoved = state.drag.moved;
      var fromSq = state.drag.from;
      state.drag = null;
      if (!wasMoved) return; // treat as a plain tap, already handled on pointerdown
      var target = document.elementFromPoint(ev.clientX, ev.clientY);
      var targetSqEl = target && target.closest ? target.closest('.sq') : null;
      if (targetSqEl && targetSqEl.dataset.square) {
        if (state.legalTargets.indexOf(targetSqEl.dataset.square) !== -1) {
          tryPlayerMove(fromSq, targetSqEl.dataset.square);
        } else {
          renderMainBoard();
        }
      } else {
        renderMainBoard();
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  /* ---------------------------------------------------------
     9. PROMOTION MODAL
     --------------------------------------------------------- */
  function openPromotionModal(color) {
    var order = ['q', 'r', 'b', 'n'];
    var container = $('promotionChoices');
    container.innerHTML = '';
    order.forEach(function (type) {
      var btn = document.createElement('div');
      btn.className = 'promo-piece';
      btn.textContent = PIECE_UNICODE[color][type];
      btn.addEventListener('click', function () {
        $('promotionModal').classList.add('hidden');
        var p = state.pendingPromotion;
        state.pendingPromotion = null;
        if (p) { finalizePlayerMove(p.from, p.to, type); }
      });
      container.appendChild(btn);
    });
    $('promotionModal').classList.remove('hidden');
  }

  /* ---------------------------------------------------------
     10. MOVE BOOKKEEPING (position history for anti-repetition,
         move list, status bar)
     --------------------------------------------------------- */
  function rebuildPositionHistory() {
    var temp = new Chess();
    var keys = [positionKey(temp.fen())];
    var verboseHistory = state.game.history({ verbose: true });
    verboseHistory.forEach(function (m) {
      temp.move({ from: m.from, to: m.to, promotion: m.promotion });
      keys.push(positionKey(temp.fen()));
    });
    state.positionHistoryKeys = keys;
  }

  function applyPostMoveEffects(moveResult) {
    state.lastMove = { from: moveResult.from, to: moveResult.to };
    state.redoStack = [];
    state.positionHistoryKeys.push(positionKey(state.game.fen()));

    if (moveResult.flags && moveResult.flags.indexOf('c') !== -1) { soundCapture(); } else { soundMove(); }
    if (state.game.in_check()) { soundCheck(); }

    updateMoveList();
    checkGameOverAndHandle();
  }

  function updateMoveList() {
    var history = state.game.history();
    $('moveCount').textContent = history.length;
    var html = '';
    for (var i = 0; i < history.length; i += 2) {
      var num = i / 2 + 1;
      html += '<li>' + num + '. ' + history[i] + (history[i + 1] ? ' ' + history[i + 1] : '') + '</li>';
    }
    $('moveList').innerHTML = html;
  }

  function statusText() {
    if (state.gameOver) return $('statusBar').textContent; // frozen at game-over message
    if (state.thinking) return 'KAISOUL AI đang suy nghĩ…';
    var turn = state.game.turn();
    var turnLabel = turn === 'w' ? 'Trắng' : 'Đen';
    if (state.game.in_check()) return 'Chiếu! Lượt của ' + turnLabel;
    return 'Lượt của ' + turnLabel;
  }

  function updateStatus() {
    $('statusBar').textContent = statusText();
    $('thinkingBanner').classList.toggle('hidden', !state.thinking);

    var whiteIsBottom = state.gameMode === '2p' ? true : state.playerColor === 'w';
    var bottomIsWhiteTurn = state.game.turn() === (whiteIsBottom ? 'w' : 'b');
    $('bottomPlayerCard').classList.toggle('active-turn', bottomIsWhiteTurn && !state.gameOver);
    $('topPlayerCard').classList.toggle('active-turn', !bottomIsWhiteTurn && !state.gameOver);

    updateControlsEnabled();
  }

  function updateControlsEnabled() {
    var hasHistory = state.game.history().length > 0;
    $('undoBtn').disabled = !hasHistory || state.thinking;
    $('redoBtn').disabled = state.redoStack.length === 0 || state.thinking;
    $('hintBtn').disabled = state.gameMode !== 'ai' || state.gameOver || state.thinking || !isPlayerTurn();
    $('resignBtn').disabled = state.gameOver;
  }

  /* ---------------------------------------------------------
     11. GAME OVER HANDLING
     --------------------------------------------------------- */
  function checkGameOverAndHandle() {
    if (!state.game.game_over()) return false;
    state.gameOver = true;
    soundGameOver();

    var title, desc, icon, resultForPlayer;
    if (state.game.in_checkmate()) {
      var winnerIsWhite = state.game.turn() === 'b'; // side NOT to move just delivered mate
      if (state.gameMode === '2p') {
        title = (winnerIsWhite ? 'Trắng' : 'Đen') + ' thắng!';
        resultForPlayer = 'draw'; // not meaningful in 2p
      } else {
        var playerWon = (winnerIsWhite && state.playerColor === 'w') || (!winnerIsWhite && state.playerColor === 'b');
        title = playerWon ? 'Bạn thắng!' : 'KAISOUL AI thắng!';
        resultForPlayer = playerWon ? 'win' : 'loss';
      }
      desc = 'Chiếu hết.';
      icon = state.gameMode === 'ai' && resultForPlayer === 'loss' ? '🤖' : '🏆';
    } else if (state.game.in_stalemate()) {
      title = 'Hòa cờ'; desc = 'Hết nước đi hợp lệ (stalemate).'; icon = '🤝'; resultForPlayer = 'draw';
    } else if (state.game.in_threefold_repetition()) {
      title = 'Hòa cờ'; desc = 'Lặp lại thế cờ 3 lần.'; icon = '🤝'; resultForPlayer = 'draw';
    } else if (state.game.insufficient_material()) {
      title = 'Hòa cờ'; desc = 'Không đủ quân để chiếu hết.'; icon = '🤝'; resultForPlayer = 'draw';
    } else {
      title = 'Hòa cờ'; desc = 'Ván đấu kết thúc hòa.'; icon = '🤝'; resultForPlayer = 'draw';
    }

    showGameOverModal(icon, title, desc);

    if (state.gameMode === 'ai') {
      pushHistory({
        date: new Date().toISOString(),
        mode: 'ai',
        elo: state.aiElo,
        playerColor: state.playerColor,
        result: resultForPlayer,
        pgn: state.game.pgn()
      });
    }
    updateStatus();
    updateControlsEnabled();
    return true;
  }

  function showGameOverModal(icon, title, desc) {
    $('gameOverIcon').textContent = icon;
    $('gameOverTitle').textContent = title;
    $('gameOverDesc').textContent = desc;
    $('gameOverModal').classList.remove('hidden');
  }

  function resign() {
    if (state.gameOver) return;
    askConfirm('Đầu hàng?', 'Bạn sẽ thua ván đấu này.', function () {
      if (state.engine) { state.engine.stop(); }
      state.thinking = false;
      state.gameOver = true;
      var icon = '🤖', title = 'Bạn đã đầu hàng', desc = 'KAISOUL AI thắng.';
      if (state.gameMode === '2p') { title = 'Đã đầu hàng'; desc = 'Ván đấu kết thúc.'; }
      showGameOverModal(icon, title, desc);
      if (state.gameMode === 'ai') {
        pushHistory({ date: new Date().toISOString(), mode: 'ai', elo: state.aiElo, playerColor: state.playerColor, result: 'loss', pgn: state.game.pgn() });
      }
      $('statusBar').textContent = title;
      updateControlsEnabled();
    });
  }

  /* ---------------------------------------------------------
     12. ENGINE LIFECYCLE & AI ORCHESTRATION
     --------------------------------------------------------- */
  function ensureEngine() {
    if (state.engineReadyPromise) return state.engineReadyPromise;
    state.engine = new KaisoulEngine();
    state.engineReadyPromise = state.engine.init().then(function (ok) {
      if (!ok) { showEngineError('Không thể tải Chess AI. Bạn vẫn có thể chơi ở chế độ Hai người chơi.'); }
      else { state.engine.newGame(); }
      return ok;
    });
    return state.engineReadyPromise;
  }

  function showEngineError(text) {
    $('engineErrorText').textContent = text;
    $('engineErrorBanner').classList.remove('hidden');
  }
  $('engineErrorClose').addEventListener('click', function () { $('engineErrorBanner').classList.add('hidden'); });

  function engineGoAsync(opts) {
    return new Promise(function (resolve) {
      state.engine.go(opts, null, resolve);
    });
  }

  function uciToMoveObj(uci) {
    var mv = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    if (uci.length > 4) { mv.promotion = uci[4]; }
    return mv;
  }

  function candidateCausesRepetition(fen, uci) {
    try {
      var clone = new Chess(fen);
      var res = clone.move(uciToMoveObj(uci));
      if (!res) return { invalid: true };
      var key = positionKey(clone.fen());
      var occurrences = state.positionHistoryKeys.filter(function (k) { return k === key; }).length;
      return { invalid: false, occurrences: occurrences };
    } catch (e) {
      return { invalid: true };
    }
  }

  function pickNonRepeatingCandidate(candidates, fen) {
    var best = null;
    var bestOccurrences = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var uci = candidates[i].move;
      if (!uci) continue;
      var check = candidateCausesRepetition(fen, uci);
      if (check.invalid) continue;
      if (check.occurrences === 0) { return uci; }
      if (check.occurrences < bestOccurrences) { bestOccurrences = check.occurrences; best = uci; }
    }
    return best;
  }

  function requestAiMove() {
    if (state.gameOver) return;
    state.thinking = true;
    updateStatus();

    ensureEngine().then(function (ok) {
      if (!ok) { state.thinking = false; updateStatus(); fallbackRandomAiMove(); return; }
      if (state.gameOver) { state.thinking = false; return; }

      var fen = state.game.fen();
      var strength = state.engine.applyStrength(state.aiElo, SPEED_MULTIPLIER[state.settings.aiSpeed] || 1);
      var searchTimeout = strength.movetime + 6000;

      engineGoAsync({ fen: fen, depth: strength.depth, movetime: strength.movetime, multipv: 3, timeoutMs: searchTimeout })
        .then(function (result) {
          if (!result.ok) { return { finalResult: result, chosen: null }; }
          var chosen = pickNonRepeatingCandidate(result.candidates, fen);
          if (chosen) { return { finalResult: result, chosen: chosen }; }
          // Widen the search per spec: MultiPV 3 -> 6 if every candidate repeats.
          return engineGoAsync({ fen: fen, depth: strength.depth, movetime: strength.movetime, multipv: 6, timeoutMs: searchTimeout })
            .then(function (result2) {
              if (!result2.ok) { return { finalResult: result, chosen: result.bestMove }; }
              var chosen2 = pickNonRepeatingCandidate(result2.candidates, fen);
              return { finalResult: result2, chosen: chosen2 || result2.bestMove };
            });
        })
        .then(function (outcome) {
          state.thinking = false;
          if (outcome.finalResult.reason === 'stopped') { updateStatus(); return; }
          if (state.gameOver) { updateStatus(); return; }
          if (!outcome.finalResult.ok) {
            updateStatus();
            handleEngineFailure(outcome.finalResult.reason);
            return;
          }
          var moveUci = outcome.chosen || outcome.finalResult.bestMove;
          if (!moveUci) { fallbackRandomAiMove(); return; }
          applyAiUciMove(moveUci);
        });
    });
  }

  function applyAiUciMove(uci) {
    var moveObj = uciToMoveObj(uci);
    var result = state.game.move(moveObj);
    if (!result) {
      // Engine proposed something Chess.js rejects — never let the AI play
      // an illegal move. Fall back to a safe random legal move instead.
      console.error('KAISOUL: engine move rejected by Chess.js, falling back', uci);
      fallbackRandomAiMove();
      return;
    }
    applyPostMoveEffects(result);
    renderMainBoard();
    updateStatus();
  }

  function fallbackRandomAiMove() {
    if (state.gameOver) return;
    var moves = state.game.moves({ verbose: true });
    if (moves.length === 0) { checkGameOverAndHandle(); return; }
    var pick = moves[Math.floor(Math.random() * moves.length)];
    var result = state.game.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
    if (result) { applyPostMoveEffects(result); renderMainBoard(); updateStatus(); }
  }

  function handleEngineFailure(reason) {
    var text = reason === 'timeout'
      ? 'KAISOUL AI không phản hồi kịp thời. Bạn có thể thử lại nước đi.'
      : 'Đã xảy ra lỗi với Chess AI.';
    showEngineError(text);
  }

  function requestHint() {
    if (state.gameMode !== 'ai' || state.gameOver || state.thinking || !isPlayerTurn()) return;
    state.thinking = true;
    updateStatus();
    ensureEngine().then(function (ok) {
      if (!ok) { state.thinking = false; updateStatus(); return; }
      var fen = state.game.fen();
      var strength = state.engine.applyStrength(Math.max(state.aiElo, 1400), 0.6);
      engineGoAsync({ fen: fen, depth: strength.depth, movetime: Math.min(strength.movetime, 1200), multipv: 1, timeoutMs: strength.movetime + 4000 })
        .then(function (result) {
          state.thinking = false;
          updateStatus();
          if (!result.ok || !result.bestMove) { return; }
          var mv = uciToMoveObj(result.bestMove);
          state.selected = mv.from;
          state.legalTargets = [mv.to];
          renderMainBoard();
        });
    });
  }

  /* ---------------------------------------------------------
     13. UNDO / REDO / RESTART
     --------------------------------------------------------- */
  function undo() {
    if (state.game.history().length === 0) return;
    if (state.engine) { state.engine.stop(); }
    state.thinking = false;

    var undoneMoves = [];
    var first = state.game.undo();
    if (first) undoneMoves.push(first);

    if (state.gameMode === 'ai' && first) {
      // Keep undoing until it is the human player's turn again.
      while (state.game.history().length > 0 && state.game.turn() !== state.playerColor) {
        var next = state.game.undo();
        if (!next) break;
        undoneMoves.push(next);
      }
    }
    // undoneMoves was collected newest-first (AI's reply, then the player's
    // move); redo must replay them oldest-first, so reverse before storing.
    undoneMoves.reverse();
    state.redoStack = undoneMoves.concat(state.redoStack);

    state.gameOver = false;
    $('gameOverModal').classList.add('hidden');
    rebuildPositionHistory();
    clearSelection();
    state.lastMove = lastMoveFromHistory();
    renderMainBoard();
    updateMoveList();
    updateStatus();
  }

  function redo() {
    if (state.redoStack.length === 0) return;
    var mv = state.redoStack.shift();
    var result = state.game.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    if (!result) { return; }
    state.positionHistoryKeys.push(positionKey(state.game.fen()));
    state.lastMove = { from: result.from, to: result.to };
    updateMoveList();
    var over = checkGameOverAndHandle();
    renderMainBoard();
    updateStatus();
    if (!over && state.gameMode === 'ai' && state.redoStack.length === 0 && state.game.turn() !== state.playerColor) {
      setTimeout(requestAiMove, 260);
    }
  }

  function lastMoveFromHistory() {
    var hist = state.game.history({ verbose: true });
    if (hist.length === 0) return null;
    var m = hist[hist.length - 1];
    return { from: m.from, to: m.to };
  }

  function restartGame() {
    askConfirm('Chơi lại?', 'Ván đấu hiện tại sẽ bị hủy.', function () {
      if (state.engine) { state.engine.stop(); }
      startGame(state.gameMode, { keepConfig: true });
    });
  }

  /* ---------------------------------------------------------
     14. STARTING A GAME
     --------------------------------------------------------- */
  function startGame(mode, opts) {
    opts = opts || {};
    state.gameMode = mode;
    state.game = new Chess();
    state.selected = null;
    state.legalTargets = [];
    state.lastMove = null;
    state.redoStack = [];
    state.gameOver = false;
    state.thinking = false;
    rebuildPositionHistory();

    if (mode === 'ai') {
      var chosenColor = $('colorChoiceRow').querySelector('.choice-btn.active').dataset.color;
      if (chosenColor === 'random') { chosenColor = Math.random() < 0.5 ? 'white' : 'black'; }
      state.playerColor = chosenColor === 'white' ? 'w' : 'b';
      state.aiElo = ELO_STEPS[Number($('eloSlider').value)];

      $('topPlayerAvatar').textContent = '🤖';
      $('topPlayerName').textContent = 'KAISOUL AI';
      $('topPlayerSub').textContent = 'ELO ' + state.aiElo;
      $('bottomPlayerAvatar').textContent = '🧑';
      $('bottomPlayerName').textContent = 'Bạn';
      $('bottomPlayerSub').textContent = 'ELO ' + state.aiElo;

      ensureEngine().then(function (ok) {
        if (ok) { state.engine.newGame(); }
      });
    } else {
      $('topPlayerAvatar').textContent = '⚫';
      $('topPlayerName').textContent = 'Người chơi Đen';
      $('topPlayerSub').textContent = 'Local';
      $('bottomPlayerAvatar').textContent = '⚪';
      $('bottomPlayerName').textContent = 'Người chơi Trắng';
      $('bottomPlayerSub').textContent = 'Local';
    }

    goToScreen('game', { replace: screenStack[screenStack.length - 1] === 'game' });
    renderMainBoard();
    updateMoveList();
    updateStatus();
    $('gameOverModal').classList.add('hidden');

    if (mode === 'ai' && state.playerColor === 'b') {
      setTimeout(requestAiMove, 400);
    }
  }

  /* ---------------------------------------------------------
     15. PUZZLE MODE
     --------------------------------------------------------- */
  function buildPuzzleData() {
    return [
      {
        fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1',
        solution: 'e1e8',
        desc: 'Trắng đi. Tìm nước chiếu hết ở hàng ngang cuối.'
      },
      {
        fen: '6k1/5ppp/8/8/8/8/6PP/3R2K1 w - - 0 1',
        solution: 'd1d8',
        desc: 'Trắng đi. Xe có thể chiếu hết ngay lập tức bằng cách nào?'
      },
      {
        fen: 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1',
        solution: 'b5c7',
        desc: 'Trắng đi. Tìm nước chạc quân (fork) thắng xe.'
      }
    ];
  }

  function loadPuzzle(index) {
    var puzzles = state.puzzles;
    index = ((index % puzzles.length) + puzzles.length) % puzzles.length;
    state.puzzleIndex = index;
    var puzzle = puzzles[index];
    state.puzzleGame = new Chess(puzzle.fen);
    state.puzzleLocked = false;
    state.puzzleSelected = null;
    $('puzzleIndex').textContent = index + 1;
    $('puzzleTotal').textContent = puzzles.length;
    $('puzzleStatus').textContent = puzzle.desc;
    $('puzzleScore').textContent = state.puzzleScore;
    renderPuzzleBoard();
  }

  function renderPuzzleBoard() {
    renderBoard($('puzzleBoard'), state.puzzleGame, true, {
      selected: state.puzzleSelected,
      legalTargets: state.puzzleSelected ? state.puzzleGame.moves({ square: state.puzzleSelected, verbose: true }).map(function (m) { return m.to; }) : [],
      lastMove: null,
      checkSquare: null
    });
  }

  $('puzzleBoard').addEventListener('click', function (e) {
    var sqEl = e.target.closest ? e.target.closest('.sq') : null;
    if (!sqEl || state.puzzleLocked) return;
    var sqName = sqEl.dataset.square;
    var puzzle = state.puzzles[state.puzzleIndex];

    if (state.puzzleSelected) {
      var moves = state.puzzleGame.moves({ square: state.puzzleSelected, verbose: true });
      var match = moves.filter(function (m) { return m.to === sqName; });
      if (match.length > 0) {
        var uciTried = state.puzzleSelected + sqName + (match[0].promotion || '');
        var uciExpected = puzzle.solution;
        var correct = uciTried.slice(0, 4) === uciExpected.slice(0, 4);
        if (correct) {
          state.puzzleGame.move({ from: match[0].from, to: match[0].to, promotion: match[0].promotion });
          state.puzzleSelected = null;
          state.puzzleLocked = true;
          renderPuzzleBoard();
          state.puzzleScore += 10;
          $('puzzleScore').textContent = state.puzzleScore;
          $('puzzleStatus').textContent = '✅ Chính xác! Nhấn "Tiếp theo" để qua bài tiếp theo.';
          soundCheck();
        } else {
          $('puzzleStatus').textContent = '❌ Chưa đúng, thử lại.';
          state.puzzleSelected = null;
          renderPuzzleBoard();
        }
        return;
      }
      var p2 = state.puzzleGame.get(sqName);
      if (p2 && p2.color === state.puzzleGame.turn()) { state.puzzleSelected = sqName; renderPuzzleBoard(); return; }
      state.puzzleSelected = null;
      renderPuzzleBoard();
      return;
    }

    var piece = state.puzzleGame.get(sqName);
    if (piece && piece.color === state.puzzleGame.turn()) {
      state.puzzleSelected = sqName;
      renderPuzzleBoard();
    }
  });

  $('puzzleRetryBtn').addEventListener('click', function () { loadPuzzle(state.puzzleIndex); });
  $('puzzleNextBtn').addEventListener('click', function () { loadPuzzle(state.puzzleIndex + 1); });

  /* ---------------------------------------------------------
     16. HISTORY LIST (settings screen)
     --------------------------------------------------------- */
  function renderHistoryList() {
    var list = loadHistory();
    var container = $('historyList');
    if (list.length === 0) {
      container.innerHTML = '<p class="empty-note">Chưa có trận đấu nào.</p>';
      return;
    }
    var labels = { win: ['Thắng', 'win'], loss: ['Thua', 'loss'], draw: ['Hòa', 'draw'] };
    container.innerHTML = list.map(function (item) {
      var d = new Date(item.date);
      var dateStr = d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      var lbl = labels[item.result] || ['—', 'draw'];
      return '<div class="history-item"><span>' + dateStr + ' · ELO ' + item.elo + '</span>' +
        '<span class="history-result ' + lbl[1] + '">' + lbl[0] + '</span></div>';
    }).join('');
  }

  /* ---------------------------------------------------------
     17. SETTINGS SCREEN WIRING
     --------------------------------------------------------- */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.darkMode ? 'dark' : 'light');
  }

  function syncSettingsUI() {
    $('setDarkMode').checked = state.settings.darkMode;
    $('setSound').checked = state.settings.sound;
    $('setAnimation').checked = state.settings.animation;
    $('setShowLegal').checked = state.settings.showLegal;
    $('setShowCoords').checked = state.settings.showCoords;
    document.querySelectorAll('#aiSpeedRow .choice-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.speed === state.settings.aiSpeed);
    });
  }

  $('setDarkMode').addEventListener('change', function (e) { state.settings.darkMode = e.target.checked; applyTheme(); saveSettings(); });
  $('setSound').addEventListener('change', function (e) { state.settings.sound = e.target.checked; saveSettings(); });
  $('setAnimation').addEventListener('change', function (e) { state.settings.animation = e.target.checked; saveSettings(); if (state.game) renderMainBoard(); });
  $('setShowLegal').addEventListener('change', function (e) { state.settings.showLegal = e.target.checked; saveSettings(); if (state.game) renderMainBoard(); });
  $('setShowCoords').addEventListener('change', function (e) { state.settings.showCoords = e.target.checked; saveSettings(); if (state.game) renderMainBoard(); });
  document.querySelectorAll('#aiSpeedRow .choice-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#aiSpeedRow .choice-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.settings.aiSpeed = btn.dataset.speed;
      saveSettings();
    });
  });
  $('clearHistoryBtn').addEventListener('click', function () {
    askConfirm('Xóa lịch sử?', 'Toàn bộ lịch sử trận đấu sẽ bị xóa vĩnh viễn.', clearHistory);
  });

  /* ---------------------------------------------------------
     18. SETUP-AI SCREEN WIRING
     --------------------------------------------------------- */
  $('eloSlider').addEventListener('input', function (e) {
    $('eloValueDisplay').textContent = ELO_STEPS[Number(e.target.value)];
  });
  document.querySelectorAll('#colorChoiceRow .choice-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#colorChoiceRow .choice-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
  $('startAiGameBtn').addEventListener('click', function () { startGame('ai'); });
  $('start2pGameBtn').addEventListener('click', function () { startGame('2p'); });

  /* ---------------------------------------------------------
     19. GAME CONTROLS WIRING
     --------------------------------------------------------- */
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('hintBtn').addEventListener('click', requestHint);
  $('restartBtn').addEventListener('click', restartGame);
  $('resignBtn').addEventListener('click', resign);
  $('gameSettingsBtn').addEventListener('click', function () { goToScreen('settings'); });
  $('gameOverRematchBtn').addEventListener('click', function () {
    $('gameOverModal').classList.add('hidden');
    startGame(state.gameMode, { keepConfig: true });
  });
  $('gameOverMenuBtn').addEventListener('click', function () {
    $('gameOverModal').classList.add('hidden');
    if (state.engine) { state.engine.stop(); }
    screenStack = ['menu'];
    goToScreen('menu', { replace: true });
  });

  /* ---------------------------------------------------------
     20. GLOBAL NAV WIRING
     --------------------------------------------------------- */
  document.querySelectorAll('[data-nav]').forEach(function (btn) {
    btn.addEventListener('click', function () { goToScreen(btn.dataset.nav); });
  });
  $('backBtn').addEventListener('click', goBack);
  $('settingsHeaderBtn').addEventListener('click', function () { goToScreen('settings'); });

  /* ---------------------------------------------------------
     21. CLEANUP ON EXIT
     --------------------------------------------------------- */
  window.addEventListener('beforeunload', function () {
    if (state.engine) { state.engine.destroy(); }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.engine && state.thinking) {
      // Don't destroy (would lose the engine for a quick tab-switch),
      // just stop the current search so it doesn't run needlessly.
      state.engine.stop();
      state.thinking = false;
    }
  });

  /* ---------------------------------------------------------
     22. PWA SERVICE WORKER
     --------------------------------------------------------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function (err) {
        console.warn('KAISOUL: service worker registration failed', err);
      });
    });
  }

  /* ---------------------------------------------------------
     23. BOOT
     --------------------------------------------------------- */
  applyTheme();
  syncSettingsUI();
  renderHistoryList();
  loadPuzzle(0);
  goToScreen('menu', { replace: true });

} catch (bootError) {
  console.error('KAISOUL boot error:', bootError);
  if (window.__kaisoulShowFatal) {
    window.__kaisoulShowFatal('Không thể khởi động ứng dụng. Vui lòng thử lại.');
  }
}
