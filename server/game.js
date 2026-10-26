/**
 * In-memory room + game state for 反應擂台 (Reaction Arena).
 * Max 8 players. Reaction tap game — not RPS.
 */

const { v4: uuidv4 } = require('uuid');

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const DEFAULT_TARGET_ROUNDS = 10;
const COUNTDOWN_MS = 2500;
const TARGET_WINDOW_MS = 4000; // how long target stays clickable
const BETWEEN_ROUNDS_MS = 2800;
const RESULT_FLASH_MS = 1800;

const COLORS = [
  { id: 'red', hex: '#e85d5d' },
  { id: 'blue', hex: '#6b8cff' },
  { id: 'green', hex: '#3ecf8e' },
  { id: 'yellow', hex: '#e6c86a' },
  { id: 'purple', hex: '#b07cff' },
  { id: 'orange', hex: '#ff9f43' },
];

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'hexagon'];

const WORDS = {
  'zh-TW': ['快', '擊', '準', '閃', '爆', '速', '瞄', '中'],
  'zh-CN': ['快', '击', '准', '闪', '爆', '速', '瞄', '中'],
  en: ['GO', 'HIT', 'TAP', 'NOW', 'YES', 'BAM', 'POW', 'AIM'],
};

const ROUND_TYPES = ['color', 'shape', 'word'];

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function scoreForRank(rank) {
  // 1st: 100, 2nd: 70, 3rd: 50, rest correct: 30
  if (rank === 1) return 100;
  if (rank === 2) return 70;
  if (rank === 3) return 50;
  return 30;
}

const WRONG_PENALTY = 20;

class Room {
  constructor(hostSocketId, hostNickname, settings = {}) {
    this.code = genRoomCode();
    this.hostId = hostSocketId;
    this.createdAt = Date.now();
    this.players = new Map();
    this.mode = 'players';
    this.settings = {
      targetRounds: Math.min(30, Math.max(1, +(settings.targetRounds || DEFAULT_TARGET_ROUNDS))),
      seats: Math.min(8, Math.max(2, +(settings.seats || 4))),
    };
    this.phase = 'lobby'; // lobby | countdown | playing | result | between | ended
    this.ended = false;
    this.roundIndex = 0;
    this.roundsPlayed = 0;
    this.countdownEndsAt = null;
    this.targetAppearsAt = null;
    this.playingEndsAt = null;
    this.resultEndsAt = null;
    this.betweenEndsAt = null;
    this.currentRound = null; // { type, targetId, options, label, colorHex, shape, word }
    this.roundAnswers = new Map(); // socketId -> { correct, ms, at, optionId }
    this.lastRoundResult = null;
    this.roundTypeCursor = 0;
    this.addPlayer(hostSocketId, hostNickname, true);
  }

  addPlayer(socketId, nickname, isHost = false) {
    if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'room_full' };
    if (this.phase !== 'lobby' && this.phase !== 'ended') {
      return { ok: false, error: 'game_started' };
    }
    const nick = (nickname || 'Player').trim().slice(0, 16) || 'Player';
    this.players.set(socketId, {
      id: socketId,
      nickname: nick,
      isHost,
      ready: false,
      connected: true,
      isBot: false,
      score: 0,
      correctCount: 0,
      wrongCount: 0,
      bestMs: null,
    });
    return { ok: true };
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.roundAnswers.delete(socketId);
    if (this.hostId === socketId) {
      const next = this.players.keys().next().value;
      this.hostId = next || null;
      if (next) this.players.get(next).isHost = true;
    }
  }

  updateSettings(socketId, partial = {}) {
    if (socketId !== this.hostId || this.phase !== 'lobby') return { ok: false };
    if (partial.targetRounds != null) {
      this.settings.targetRounds = Math.min(30, Math.max(1, +partial.targetRounds || DEFAULT_TARGET_ROUNDS));
    }
    if (partial.seats != null) {
      this.settings.seats = Math.min(8, Math.max(2, +partial.seats || 4));
    }
    return { ok: true };
  }

  setReady(socketId, ready) {
    const p = this.players.get(socketId);
    if (!p || this.phase !== 'lobby') return;
    p.ready = !!ready;
  }

  humanCount() {
    return [...this.players.values()].filter((p) => !p.isBot && p.connected).length;
  }

  startGame(socketId) {
    if (socketId !== this.hostId) return { ok: false, error: 'not_host' };
    if (this.phase !== 'lobby' && this.phase !== 'ended') return { ok: false, error: 'already_started' };
    if (this.players.size < MIN_PLAYERS && this.mode !== 'practice') {
      // allow solo if practice mode, otherwise need 2
      if (this.players.size < 1) return { ok: false, error: 'need_players' };
      if (this.players.size < MIN_PLAYERS) return { ok: false, error: 'need_players' };
    }
    // reset scores
    for (const p of this.players.values()) {
      p.score = 0;
      p.correctCount = 0;
      p.wrongCount = 0;
      p.bestMs = null;
      p.ready = true;
    }
    this.ended = false;
    this.roundIndex = 0;
    this.roundsPlayed = 0;
    this.roundTypeCursor = 0;
    this.lastRoundResult = null;
    this.roundAnswers.clear();
    this.beginCountdown();
    return { ok: true };
  }

  beginCountdown() {
    this.roundIndex += 1;
    this.phase = 'countdown';
    this.currentRound = null;
    this.roundAnswers.clear();
    this.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.targetAppearsAt = null;
    this.playingEndsAt = null;
    this.resultEndsAt = null;
    this.betweenEndsAt = null;
    return true;
  }

  generateRound() {
    const type = ROUND_TYPES[this.roundTypeCursor % ROUND_TYPES.length];
    this.roundTypeCursor += 1;
    const optionCount = Math.min(4, 3 + Math.floor(Math.random() * 2)); // 3 or 4

    if (type === 'color') {
      const shuffled = shuffle(COLORS);
      const opts = shuffled.slice(0, optionCount);
      const target = opts[0];
      const options = shuffle(opts).map((c) => ({
        id: c.id,
        kind: 'color',
        label: c.id,
        colorHex: c.hex,
      }));
      return {
        type: 'color',
        targetId: target.id,
        options,
        flash: { kind: 'color', colorHex: target.hex, label: target.id },
      };
    }

    if (type === 'shape') {
      const shuffled = shuffle(SHAPES);
      const opts = shuffled.slice(0, optionCount);
      const target = opts[0];
      const color = pick(COLORS);
      const options = shuffle(opts).map((s) => ({
        id: s,
        kind: 'shape',
        shape: s,
        colorHex: color.hex,
      }));
      return {
        type: 'shape',
        targetId: target,
        options,
        flash: { kind: 'shape', shape: target, colorHex: color.hex },
      };
    }

    // word
    const langWords = WORDS['zh-TW'];
    const shuffled = shuffle(langWords);
    const opts = shuffled.slice(0, optionCount);
    const target = opts[0];
    const options = shuffle(opts).map((w) => ({
      id: w,
      kind: 'word',
      label: w,
    }));
    return {
      type: 'word',
      targetId: target,
      options,
      flash: { kind: 'word', label: target },
    };
  }

  beginPlaying() {
    if (this.phase !== 'countdown') return false;
    if (Date.now() < this.countdownEndsAt) return false;
    this.currentRound = this.generateRound();
    this.currentRound.id = uuidv4();
    this.phase = 'playing';
    this.targetAppearsAt = Date.now();
    this.playingEndsAt = this.targetAppearsAt + TARGET_WINDOW_MS;
    this.countdownEndsAt = null;
    return true;
  }

  submitTap(socketId, optionId) {
    if (this.phase !== 'playing' || !this.currentRound) {
      return { ok: false, error: 'not_playing' };
    }
    if (this.roundAnswers.has(socketId)) {
      return { ok: false, error: 'already_tapped' };
    }
    const p = this.players.get(socketId);
    if (!p) return { ok: false, error: 'not_in_room' };

    const now = Date.now();
    const ms = Math.max(0, now - this.targetAppearsAt);
    const correct = optionId === this.currentRound.targetId;

    this.roundAnswers.set(socketId, {
      optionId,
      correct,
      ms,
      at: now,
    });

    // If everyone answered, close early
    const active = [...this.players.values()].filter((x) => x.connected && !x.isBot);
    // count bots too if any
    const eligible = [...this.players.values()].filter((x) => x.connected);
    if (this.roundAnswers.size >= eligible.length) {
      this.finishRound();
    }

    return { ok: true, correct, ms };
  }

  maybeTimeoutPlaying() {
    if (this.phase !== 'playing') return false;
    if (Date.now() < this.playingEndsAt) return false;
    this.finishRound();
    return true;
  }

  finishRound() {
    if (this.phase !== 'playing') return;
    const answers = [...this.roundAnswers.entries()].map(([id, a]) => ({
      id,
      ...a,
      nickname: this.players.get(id)?.nickname || '?',
    }));

    // Rank correct answers by ms ascending
    const correct = answers.filter((a) => a.correct).sort((a, b) => a.ms - b.ms);
    const wrong = answers.filter((a) => !a.correct);

    const scored = [];
    correct.forEach((a, i) => {
      const rank = i + 1;
      const pts = scoreForRank(rank);
      const p = this.players.get(a.id);
      if (p) {
        p.score += pts;
        p.correctCount += 1;
        if (p.bestMs == null || a.ms < p.bestMs) p.bestMs = a.ms;
      }
      scored.push({
        id: a.id,
        nickname: a.nickname,
        correct: true,
        ms: a.ms,
        rank,
        delta: pts,
        score: p ? p.score : 0,
      });
    });

    wrong.forEach((a) => {
      const p = this.players.get(a.id);
      if (p) {
        p.score = Math.max(0, p.score - WRONG_PENALTY);
        p.wrongCount += 1;
      }
      scored.push({
        id: a.id,
        nickname: a.nickname,
        correct: false,
        ms: a.ms,
        rank: null,
        delta: -WRONG_PENALTY,
        score: p ? p.score : 0,
      });
    });

    // Missed players (no tap)
    for (const p of this.players.values()) {
      if (!this.roundAnswers.has(p.id) && p.connected) {
        scored.push({
          id: p.id,
          nickname: p.nickname,
          correct: false,
          ms: null,
          rank: null,
          delta: 0,
          score: p.score,
          missed: true,
        });
      }
    }

    scored.sort((a, b) => {
      if (a.correct && !b.correct) return -1;
      if (!a.correct && b.correct) return 1;
      if (a.correct && b.correct) return (a.ms || 99999) - (b.ms || 99999);
      return 0;
    });

    const winner = correct[0] || null;
    this.lastRoundResult = {
      roundIndex: this.roundIndex,
      type: this.currentRound.type,
      targetId: this.currentRound.targetId,
      flash: this.currentRound.flash,
      winner: winner
        ? { id: winner.id, nickname: winner.nickname, ms: winner.ms }
        : null,
      results: scored,
      leaderboard: this.leaderboard(),
    };
    this.roundsPlayed = this.roundIndex;
    this.phase = 'result';
    this.resultEndsAt = Date.now() + RESULT_FLASH_MS;
    this.playingEndsAt = null;
  }

  advanceAfterResult() {
    if (this.phase !== 'result') return false;
    if (Date.now() < this.resultEndsAt) return false;
    if (this.roundIndex >= this.settings.targetRounds) {
      this.endSession();
      return true;
    }
    this.phase = 'between';
    this.betweenEndsAt = Date.now() + BETWEEN_ROUNDS_MS;
    this.resultEndsAt = null;
    return true;
  }

  advanceAfterBetween() {
    if (this.phase !== 'between') return false;
    if (Date.now() < this.betweenEndsAt) return false;
    this.beginCountdown();
    return true;
  }

  endSession() {
    this.ended = true;
    this.phase = 'ended';
    this.countdownEndsAt = null;
    this.playingEndsAt = null;
    this.resultEndsAt = null;
    this.betweenEndsAt = null;
    this.currentRound = null;
    return this.podium();
  }

  hostEnd(socketId) {
    if (socketId !== this.hostId) return { ok: false, error: 'not_host' };
    const podium = this.endSession();
    return { ok: true, podium };
  }

  leaderboard() {
    return [...this.players.values()]
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        score: p.score,
        correctCount: p.correctCount,
        wrongCount: p.wrongCount,
        bestMs: p.bestMs,
        isBot: !!p.isBot,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if ((a.bestMs ?? 99999) !== (b.bestMs ?? 99999)) {
          return (a.bestMs ?? 99999) - (b.bestMs ?? 99999);
        }
        return a.nickname.localeCompare(b.nickname);
      });
  }

  podium() {
    return this.leaderboard();
  }

  publicState(viewerId = null) {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      isHost: p.isHost,
      ready: p.ready,
      connected: p.connected,
      isBot: !!p.isBot,
      score: p.score,
      correctCount: p.correctCount,
      wrongCount: p.wrongCount,
      bestMs: p.bestMs,
    }));

    let round = null;
    if (this.currentRound && (this.phase === 'playing' || this.phase === 'result')) {
      round = {
        id: this.currentRound.id,
        type: this.currentRound.type,
        options: this.currentRound.options,
        flash: this.currentRound.flash,
        // only reveal target after result
        targetId: this.phase === 'result' ? this.currentRound.targetId : null,
      };
    }

    const myAnswer = viewerId && this.roundAnswers.has(viewerId)
      ? {
          optionId: this.roundAnswers.get(viewerId).optionId,
          correct: this.phase === 'result' ? this.roundAnswers.get(viewerId).correct : null,
          ms: this.roundAnswers.get(viewerId).ms,
        }
      : null;

    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      mode: this.mode,
      settings: { ...this.settings },
      players,
      roundIndex: this.roundIndex,
      targetRounds: this.settings.targetRounds,
      countdownEndsAt: this.countdownEndsAt,
      targetAppearsAt: this.targetAppearsAt,
      playingEndsAt: this.playingEndsAt,
      resultEndsAt: this.resultEndsAt,
      betweenEndsAt: this.betweenEndsAt,
      round,
      myAnswer,
      lastRoundResult: this.lastRoundResult,
      leaderboard: this.leaderboard(),
      ended: this.ended,
      youAreHost: viewerId === this.hostId,
      yourId: viewerId,
      serverNow: Date.now(),
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.socketToRoom = new Map();
    /** @type {Array<{socketId:string, nickname:string, seats:number, joinedAt:number}>} */
    this.matchQueue = [];
  }

  create(socketId, nickname, settings) {
    const room = new Room(socketId, nickname, settings);
    while (this.rooms.has(room.code)) room.code = genRoomCode();
    this.rooms.set(room.code, room);
    this.socketToRoom.set(socketId, room.code);
    return room;
  }

  join(code, socketId, nickname) {
    const room = this.rooms.get((code || '').toUpperCase().trim());
    if (!room) return { ok: false, error: 'not_found' };
    if (room.phase === 'ended') return { ok: false, error: 'ended' };
    const res = room.addPlayer(socketId, nickname);
    if (!res.ok) return res;
    this.socketToRoom.set(socketId, room.code);
    return { ok: true, room };
  }

  getBySocket(socketId) {
    const code = this.socketToRoom.get(socketId);
    return code ? this.rooms.get(code) : null;
  }

  leave(socketId) {
    this.leaveMatchQueue(socketId);
    const room = this.getBySocket(socketId);
    this.socketToRoom.delete(socketId);
    if (!room) return null;
    room.removePlayer(socketId);
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      return null;
    }
    return room;
  }

  leaveMatchQueue(socketId) {
    this.matchQueue = this.matchQueue.filter((q) => q.socketId !== socketId);
  }

  enqueueMatch(socketId, nickname, seats = 2) {
    this.leaveMatchQueue(socketId);
    if (this.getBySocket(socketId)) return { ok: false, error: 'in_room' };
    const s = Math.min(8, Math.max(2, +seats || 2));
    this.matchQueue.push({
      socketId,
      nickname: (nickname || 'Player').slice(0, 16),
      seats: s,
      joinedAt: Date.now(),
    });
    return { ok: true, position: this.matchQueue.length, waiting: this.matchQueue.length };
  }

  tryMatchmake() {
    if (this.matchQueue.length < 2) return null;
    const oldest = this.matchQueue[0];
    const need = oldest.seats;
    if (this.matchQueue.length < need) {
      if (Date.now() - oldest.joinedAt < 8000) return null;
      const take = Math.min(this.matchQueue.length, 8);
      if (take < 2) return null;
      return this._seatFromQueue(take);
    }
    return this._seatFromQueue(need);
  }

  _seatFromQueue(count) {
    const members = this.matchQueue.splice(0, count);
    if (members.length < 2) {
      this.matchQueue.unshift(...members);
      return null;
    }
    const host = members[0];
    const room = this.create(host.socketId, host.nickname, {
      seats: members.length,
      targetRounds: DEFAULT_TARGET_ROUNDS,
    });
    room.mode = 'players';
    for (let i = 1; i < members.length; i++) {
      const m = members[i];
      room.addPlayer(m.socketId, m.nickname);
      this.socketToRoom.set(m.socketId, room.code);
    }
    for (const p of room.players.values()) p.ready = true;
    return { room, members };
  }
}

module.exports = {
  Room,
  RoomManager,
  MAX_PLAYERS,
  MIN_PLAYERS,
  DEFAULT_TARGET_ROUNDS,
  COUNTDOWN_MS,
  TARGET_WINDOW_MS,
  BETWEEN_ROUNDS_MS,
  WRONG_PENALTY,
};
