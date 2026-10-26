/* 反應擂台 client */
(function () {
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $('screen-home'),
    friends: $('screen-friends'),
    matching: $('screen-matching'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
    podium: $('screen-podium'),
  };

  let socket = null;
  let state = null;
  let myReady = false;
  let lastPhase = null;
  let countdownTimer = null;
  let tappedThisRound = false;

  function show(name) {
    Object.values(screens).forEach((el) => el && el.classList.remove('active'));
    if (screens[name]) screens[name].classList.add('active');
  }

  function nick() {
    return ($('nickname').value || '').trim().slice(0, 16);
  }

  function requireNick() {
    if (!nick()) {
      alert(t('needNick'));
      $('nickname').focus();
      return false;
    }
    localStorage.setItem('ra_nick', nick());
    return true;
  }

  function applyI18n() {
    document.title = t('title');
    $('brand').textContent = t('title');
    $('homeTitle').textContent = t('title');
    $('homeSub').textContent = t('subtitle');
    $('howTo').textContent = t('howTo');
    $('lblNick').textContent = t('nickname');
    $('nickname').placeholder = t('nicknamePh');
    $('txtRandom').textContent = t('playRandom');
    $('txtFriends').textContent = t('playFriends');
    $('friendsTitle').textContent = t('playFriends');
    $('lblRoundsF').textContent = t('targetRounds');
    $('btnCreateRoom').textContent = t('create');
    $('lblJoinCode').textContent = t('roomCode');
    $('joinCode').placeholder = t('roomCodePh');
    $('btnJoinRoom').textContent = t('join');
    $('btnBackFriends').textContent = t('back');
    $('matchingTitle').textContent = t('matching');
    $('lblMatchSeats').textContent = t('seats');
    $('btnCancelMatch').textContent = t('cancelMatch');
    $('lobbyTitle').textContent = t('lobby');
    $('shareHint').textContent = t('shareCode');
    $('btnCopyCode').textContent = t('copy');
    $('btnCopyLink').textContent = t('shareLink');
    $('lblRounds').textContent = t('targetRounds');
    $('btnStart').textContent = t('start');
    $('btnReady').textContent = myReady ? t('unready') : t('ready');
    $('btnLeaveLobby').textContent = t('leave');
    $('liveBoardTitle').textContent = t('leaderboard');
    $('btnLeaveGame').textContent = t('leave');
    $('btnEndGame').textContent = t('endGame');
    $('podiumTitle').textContent = t('podium');
    $('btnPlayAgain').textContent = t('playAgain');
    $('btnPodiumHome').textContent = t('home');
    $('connLabel').textContent = socket && socket.connected ? t('connected') : t('connecting');
  }

  function fillLangSelect() {
    const sel = $('langSelect');
    sel.innerHTML = '';
    LANG_LIST.forEach((l) => {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.label;
      if (l.code === currentLang) o.selected = true;
      sel.appendChild(o);
    });
  }

  window.onLangChange = () => {
    applyI18n();
    if (state) renderState(state);
  };

  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      $('connDot').classList.add('on');
      $('connLabel').textContent = t('connected');
    });
    socket.on('disconnect', () => {
      $('connDot').classList.remove('on');
      $('connLabel').textContent = t('connecting');
    });
    socket.on('hello', () => {});
    socket.on('room:state', (s) => {
      state = s;
      renderState(s);
    });
    socket.on('match:waiting', (info) => {
      $('matchingInfo').textContent = `${t('waiting')} #${info.position} / ${info.waiting}`;
    });
    socket.on('match:found', (payload) => {
      state = payload.state;
      show('lobby');
      renderState(state);
    });
    socket.on('game:podium', (payload) => {
      renderPodium(payload.podium);
      show('podium');
    });
  }

  function renderState(s) {
    if (!s) return;
    const phase = s.phase;

    if (phase === 'lobby') {
      show('lobby');
      renderLobby(s);
    } else if (phase === 'ended') {
      renderPodium(s.leaderboard);
      show('podium');
    } else {
      show('game');
      renderGame(s);
    }
    lastPhase = phase;
  }

  function renderLobby(s) {
    $('lobbyCode').textContent = s.code || '-----';
    const ul = $('lobbyPlayers');
    ul.innerHTML = '';
    (s.players || []).forEach((p) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = p.nickname + (p.id === s.yourId ? ` (${t('you')})` : '');
      const right = document.createElement('span');
      right.className = 'tag';
      right.textContent = p.isHost ? t('host') : p.ready ? '✓' : '…';
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    });

    const isHost = !!s.youAreHost;
    $('hostSettings').style.display = isHost ? '' : 'none';
    $('btnStart').style.display = isHost ? '' : 'none';
    if (isHost && s.settings && s.settings.targetRounds) {
      $('setRounds').value = String(s.settings.targetRounds);
    }
    myReady = !!(s.players || []).find((p) => p.id === s.yourId)?.ready;
    $('btnReady').textContent = myReady ? t('unready') : t('ready');
    $('lobbyErr').hidden = true;
  }

  function shapeEl(shape, colorHex) {
    const wrap = document.createElement('span');
    wrap.className = 'shape-icon shape-' + shape;
    if (shape === 'triangle') {
      wrap.style.borderBottomColor = colorHex;
    } else {
      wrap.style.background = colorHex;
    }
    return wrap;
  }

  function renderFlash(flash, container) {
    container.innerHTML = '';
    if (!flash) return;
    if (flash.kind === 'color') {
      const blob = document.createElement('div');
      blob.className = 'blob';
      blob.style.background = flash.colorHex;
      container.appendChild(blob);
    } else if (flash.kind === 'shape') {
      const w = document.createElement('div');
      w.className = 'shape-wrap';
      w.appendChild(shapeEl(flash.shape, flash.colorHex));
      // bigger
      const icon = w.firstChild;
      icon.style.width = '72px';
      icon.style.height = '72px';
      if (flash.shape === 'triangle') {
        icon.style.borderLeftWidth = '40px';
        icon.style.borderRightWidth = '40px';
        icon.style.borderBottomWidth = '70px';
      }
      if (flash.shape === 'diamond') {
        icon.style.width = '56px';
        icon.style.height = '56px';
      }
      container.appendChild(w);
    } else if (flash.kind === 'word') {
      const w = document.createElement('div');
      w.className = 'word-flash';
      w.textContent = flash.label;
      container.appendChild(w);
    }
  }

  function renderOptionBtn(opt) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt-btn';
    btn.dataset.optionId = opt.id;
    if (opt.kind === 'color') {
      const sw = document.createElement('span');
      sw.className = 'color-swatch';
      sw.style.background = opt.colorHex;
      btn.appendChild(sw);
    } else if (opt.kind === 'shape') {
      btn.appendChild(shapeEl(opt.shape, opt.colorHex));
    } else {
      btn.textContent = opt.label;
      btn.style.fontSize = '1.6rem';
    }
    return btn;
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function renderGame(s) {
    $('hudRound').textContent = t('roundOf', { n: s.roundIndex || 0, total: s.targetRounds || 10 });
    $('btnEndGame').style.display = s.youAreHost ? '' : 'none';

    const cd = $('countdownBig');
    const flash = $('targetFlash');
    const hint = $('tapHint');
    const grid = $('optionsGrid');
    const result = $('resultPanel');
    const between = $('betweenMsg');

    cd.hidden = true;
    flash.hidden = true;
    hint.hidden = true;
    grid.hidden = true;
    result.hidden = true;
    between.hidden = true;

    if (s.phase === 'countdown') {
      $('hudPhase').textContent = t('countdown');
      cd.hidden = false;
      clearCountdown();
      const tick = () => {
        const left = Math.max(0, (s.countdownEndsAt || 0) - Date.now());
        const n = Math.ceil(left / 1000);
        cd.textContent = n > 0 ? String(n) : '!';
        if (left <= 0) clearCountdown();
      };
      tick();
      countdownTimer = setInterval(tick, 100);
      tappedThisRound = false;
    } else if (s.phase === 'playing') {
      $('hudPhase').textContent = t('tapNow');
      clearCountdown();
      flash.hidden = false;
      hint.hidden = false;
      hint.textContent = t('tapHint');
      grid.hidden = false;
      if (s.round && s.round.flash) renderFlash(s.round.flash, flash);
      grid.innerHTML = '';
      const already = !!(s.myAnswer);
      tappedThisRound = already;
      (s.round?.options || []).forEach((opt) => {
        const btn = renderOptionBtn(opt);
        if (already) {
          btn.classList.add('disabled');
          if (s.myAnswer && s.myAnswer.optionId === opt.id) btn.classList.add('selected');
        } else {
          btn.addEventListener('click', () => onTap(opt.id, btn));
          btn.addEventListener('touchend', (e) => {
            e.preventDefault();
            onTap(opt.id, btn);
          }, { passive: false });
        }
        grid.appendChild(btn);
      });
    } else if (s.phase === 'result') {
      $('hudPhase').textContent = t('result');
      clearCountdown();
      result.hidden = false;
      const lr = s.lastRoundResult;
      result.innerHTML = '';
      if (lr && lr.winner) {
        const w = document.createElement('div');
        w.className = 'winner-line';
        w.textContent = `${t('winner')}: ${lr.winner.nickname}`;
        result.appendChild(w);
        const ms = document.createElement('div');
        ms.className = 'ms-big';
        ms.textContent = `${lr.winner.ms} ${t('ms')}`;
        result.appendChild(ms);
      } else {
        const w = document.createElement('div');
        w.className = 'winner-line';
        w.textContent = t('tooSlow');
        result.appendChild(w);
      }
      const ul = document.createElement('ul');
      ul.className = 'result-rows';
      (lr?.results || []).forEach((r) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        let status = r.missed ? t('missed') : r.correct ? t('correct') : t('wrong');
        if (r.correct && r.ms != null) status += ` ${r.ms}${t('ms')}`;
        name.textContent = `${r.nickname} · ${status}`;
        const delta = document.createElement('span');
        delta.className = r.delta > 0 ? 'delta-pos' : r.delta < 0 ? 'delta-neg' : '';
        delta.textContent = r.delta > 0 ? `+${r.delta}` : String(r.delta);
        li.appendChild(name);
        li.appendChild(delta);
        ul.appendChild(li);
      });
      result.appendChild(ul);

      // also show options with correct highlight
      if (s.round) {
        flash.hidden = false;
        if (s.round.flash) renderFlash(s.round.flash, flash);
        grid.hidden = false;
        grid.innerHTML = '';
        (s.round.options || []).forEach((opt) => {
          const btn = renderOptionBtn(opt);
          btn.classList.add('disabled');
          if (opt.id === s.round.targetId) btn.classList.add('was-correct');
          if (s.myAnswer && s.myAnswer.optionId === opt.id && !s.myAnswer.correct) {
            btn.classList.add('was-wrong');
          }
          grid.appendChild(btn);
        });
      }
    } else if (s.phase === 'between') {
      $('hudPhase').textContent = t('betweenRounds');
      clearCountdown();
      between.hidden = false;
      between.textContent = t('betweenRounds');
    }

    renderLiveBoard(s.leaderboard || []);
  }

  function renderLiveBoard(lb) {
    const ol = $('liveBoard');
    ol.innerHTML = '';
    lb.forEach((p, i) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      const badge = document.createElement('span');
      badge.className = 'rank-badge' + (i < 3 ? ` r${i + 1}` : '');
      badge.textContent = String(i + 1);
      left.appendChild(badge);
      left.appendChild(document.createTextNode(p.nickname));
      const right = document.createElement('span');
      right.className = 'score-num';
      right.textContent = `${p.score}`;
      li.appendChild(left);
      li.appendChild(right);
      ol.appendChild(li);
    });
  }

  function renderPodium(podium) {
    const ol = $('podiumList');
    ol.innerHTML = '';
    (podium || []).forEach((p, i) => {
      const li = document.createElement('li');
      if (i === 0) li.className = 'gold-row';
      const left = document.createElement('span');
      const badge = document.createElement('span');
      badge.className = 'rank-badge' + (i < 3 ? ` r${i + 1}` : '');
      badge.textContent = String(i + 1);
      left.appendChild(badge);
      left.appendChild(document.createTextNode(p.nickname));
      if (p.bestMs != null) {
        left.appendChild(document.createTextNode(` · ${p.bestMs}${t('ms')}`));
      }
      const right = document.createElement('span');
      right.className = 'score-num';
      right.textContent = `${p.score} ${t('points')}`;
      li.appendChild(left);
      li.appendChild(right);
      ol.appendChild(li);
    });
  }

  function onTap(optionId, btn) {
    if (tappedThisRound || !socket) return;
    tappedThisRound = true;
    btn.classList.add('selected');
    document.querySelectorAll('.opt-btn').forEach((b) => b.classList.add('disabled'));
    socket.emit('game:tap', { optionId }, (res) => {
      if (!res || !res.ok) {
        // allow retry only on not_playing race
        if (res && res.error === 'not_playing') {
          tappedThisRound = false;
        }
      }
    });
  }

  // —— Events ——
  $('langSelect').addEventListener('change', (e) => setLang(e.target.value));

  $('btnFriends').addEventListener('click', () => {
    if (!requireNick()) return;
    show('friends');
  });

  $('btnBackFriends').addEventListener('click', () => show('home'));

  $('btnCreateRoom').addEventListener('click', () => {
    if (!requireNick()) return;
    const rounds = +$('friendRounds').value || 10;
    socket.emit('room:create', { nickname: nick(), settings: { targetRounds: rounds } }, (res) => {
      if (res && res.ok) {
        state = res.state;
        show('lobby');
        renderState(state);
      }
    });
  });

  $('btnJoinRoom').addEventListener('click', () => {
    if (!requireNick()) return;
    const code = ($('joinCode').value || '').trim().toUpperCase();
    socket.emit('room:join', { nickname: nick(), code }, (res) => {
      if (res && res.ok) {
        state = res.state;
        show('lobby');
        renderState(state);
      } else {
        alert(t('error') + ': ' + (res?.error || 'fail'));
      }
    });
  });

  $('btnRandom').addEventListener('click', () => {
    if (!requireNick()) return;
    show('matching');
    const seats = +$('matchSeats').value || 2;
    socket.emit('match:queue', { nickname: nick(), seats }, () => {});
  });

  $('matchSeats').addEventListener('change', () => {
    // if already matching, re-queue with new seats
    if (screens.matching.classList.contains('active')) {
      const seats = +$('matchSeats').value || 2;
      socket.emit('match:cancel', () => {
        socket.emit('match:queue', { nickname: nick(), seats }, () => {});
      });
    }
  });

  $('btnCancelMatch').addEventListener('click', () => {
    socket.emit('match:cancel', () => show('home'));
  });

  $('btnCopyCode').addEventListener('click', async () => {
    const code = state?.code || '';
    try {
      await navigator.clipboard.writeText(code);
      $('btnCopyCode').textContent = t('copied');
      setTimeout(() => { $('btnCopyCode').textContent = t('copy'); }, 1200);
    } catch (_) {}
  });

  $('btnCopyLink').addEventListener('click', async () => {
    const code = state?.code || '';
    const url = `${location.origin}/?code=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      $('btnCopyLink').textContent = t('copied');
      setTimeout(() => { $('btnCopyLink').textContent = t('shareLink'); }, 1200);
    } catch (_) {}
  });

  $('setRounds').addEventListener('change', () => {
    socket.emit('room:settings', { targetRounds: +$('setRounds').value });
  });

  $('btnReady').addEventListener('click', () => {
    myReady = !myReady;
    socket.emit('room:ready', myReady);
  });

  $('btnStart').addEventListener('click', () => {
    socket.emit('game:start', (res) => {
      if (!res || !res.ok) {
        $('lobbyErr').hidden = false;
        $('lobbyErr').textContent = t(res?.error === 'need_players' ? 'needPlayers' : 'error');
      }
    });
  });

  $('btnLeaveLobby').addEventListener('click', () => {
    socket.emit('room:leave', () => {
      state = null;
      show('home');
    });
  });

  $('btnLeaveGame').addEventListener('click', () => {
    socket.emit('room:leave', () => {
      state = null;
      show('home');
    });
  });

  $('btnEndGame').addEventListener('click', () => {
    socket.emit('game:end', () => {});
  });

  $('btnPlayAgain').addEventListener('click', () => {
    // host can restart if still in room; otherwise go home
    if (state && state.youAreHost && state.phase === 'ended') {
      socket.emit('game:start', (res) => {
        if (!res || !res.ok) show('home');
      });
    } else if (state && state.code) {
      show('lobby');
    } else {
      show('home');
    }
  });

  $('btnPodiumHome').addEventListener('click', () => {
    socket.emit('room:leave', () => {
      state = null;
      show('home');
    });
  });

  // boot
  fillLangSelect();
  const savedNick = localStorage.getItem('ra_nick');
  if (savedNick) $('nickname').value = savedNick;
  applyI18n();
  connect();

  // deep link ?code=
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get('code') || '').toUpperCase();
  if (joinCode) {
    $('joinCode').value = joinCode;
    // wait for connect then auto-prompt friends screen
    socket.on('connect', () => {
      show('friends');
    });
  }
})();
