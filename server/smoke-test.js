/**
 * Quick smoke: health + Socket.IO room create/join/start/tap
 */
const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3100;
const BASE = `http://127.0.0.1:${PORT}`;

async function health() {
  const res = await fetch(`${BASE}/api/health`);
  const j = await res.json();
  if (!j.ok || j.name !== 'reaction-arena') throw new Error('health failed: ' + JSON.stringify(j));
  console.log('✓ health', j);
}

function client(name) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    const t = setTimeout(() => reject(new Error(name + ' connect timeout')), 5000);
    s.on('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on('connect_error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function emit(sock, event, payload) {
  return new Promise((resolve) => {
    sock.emit(event, payload, (res) => resolve(res));
  });
}

function waitFor(sock, event, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting ' + event)), ms);
    const handler = (data) => {
      if (!pred || pred(data)) {
        clearTimeout(t);
        sock.off(event, handler);
        resolve(data);
      }
    };
    sock.on(event, handler);
  });
}

async function main() {
  await health();
  const a = await client('A');
  const b = await client('B');
  console.log('✓ sockets connected');

  const created = await emit(a, 'room:create', { nickname: 'Alpha', settings: { targetRounds: 2 } });
  if (!created?.ok) throw new Error('create failed');
  console.log('✓ room created', created.code);

  const joined = await emit(b, 'room:join', { nickname: 'Beta', code: created.code });
  if (!joined?.ok) throw new Error('join failed');
  console.log('✓ B joined');

  const started = await emit(a, 'game:start', {});
  if (!started?.ok) throw new Error('start failed: ' + JSON.stringify(started));
  console.log('✓ game started');

  // wait until playing
  const playing = await waitFor(a, 'room:state', (s) => s.phase === 'playing', 10000);
  const opt = playing.round?.options?.[0];
  const targetFlash = playing.round?.flash;
  // tap correct if we can infer from options matching flash
  let correctId = null;
  if (targetFlash?.kind === 'color') {
    correctId = playing.round.options.find((o) => o.colorHex === targetFlash.colorHex)?.id;
  } else if (targetFlash?.kind === 'shape') {
    correctId = targetFlash.shape;
  } else if (targetFlash?.kind === 'word') {
    correctId = targetFlash.label;
  }
  if (!correctId && opt) correctId = opt.id;

  const tapA = await emit(a, 'game:tap', { optionId: correctId });
  console.log('✓ A tapped', tapA);

  // B taps something else (maybe wrong)
  const other = playing.round.options.find((o) => o.id !== correctId) || opt;
  const tapB = await emit(b, 'game:tap', { optionId: other.id });
  console.log('✓ B tapped', tapB);

  // wait for result or between
  await waitFor(a, 'room:state', (s) => s.phase === 'result' || s.phase === 'between' || s.phase === 'countdown' || s.phase === 'ended', 6000);
  console.log('✓ round progressed');

  a.close();
  b.close();
  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAIL', e);
  process.exit(1);
});
