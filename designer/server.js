// Game designer server: serves the tuning panel at / and the game, with
// designer overrides injected, at /game/. Overrides persist to
// designer/overrides.json so a tuning pass survives restarts and can be shared.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8181;
const HOST = process.env.HOST || '127.0.0.1';

const designerDir = path.dirname(fileURLToPath(import.meta.url));
const gameDir = path.resolve(designerDir, '..');
const overridesFile = path.join(designerDir, 'overrides.json');
const tracesDir = path.join(designerDir, 'traces');
const RUN_ID = /^[\w-]{1,80}$/;

async function readOverrides() {
  try {
    return JSON.parse(await fs.readFile(overridesFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// Every override is "Root/key/key..." -> finite number.
function validOverrides(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.entries(body).every(([k, v]) =>
    typeof k === 'string' && k.includes('/') && typeof v === 'number' && Number.isFinite(v));
}

// The time warp goes first so every game timer is created under it. The hook
// and bot must run after every game script has parsed and before Engine.init,
// which fires on DOM ready; right after the last event module is the spot.
const WARP_TAG = '\n\t<script src="/designer/timewarp.js"></script>';
const HOOK_TAGS =
  '\n\t<script src="/designer/overrides.js"></script>' +
  '\n\t<script src="/designer/game-hook.js"></script>' +
  '\n\t<script src="/designer/bot.js"></script>';

async function gameIndex() {
  let html = await fs.readFile(path.join(gameDir, 'index.html'), 'utf8');
  html = html.replace(/<head>/i, (m) => m + WARP_TAG);
  const anchor = '<script src="script/events/executioner.js"></script>';
  if (html.includes(anchor)) return html.replace(anchor, anchor + HOOK_TAGS);
  return html.replace('</head>', HOOK_TAGS + '\n</head>');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/overrides', async (req, res, next) => {
  try { res.json(await readOverrides()); } catch (err) { next(err); }
});

app.put('/api/overrides', async (req, res, next) => {
  if (!validOverrides(req.body)) {
    return res.status(400).json({ error: 'expected an object of "Root/path" -> finite number' });
  }
  try {
    const sorted = Object.fromEntries(Object.entries(req.body).sort(([a], [b]) => a.localeCompare(b)));
    await fs.writeFile(overridesFile, JSON.stringify(sorted, null, 2) + '\n');
    res.json({ saved: Object.keys(sorted).length });
  } catch (err) { next(err); }
});

// Bot traces: one NDJSON file per run, appended in batches as the bot plays.
app.post('/api/traces/:run', express.text({ type: 'application/x-ndjson', limit: '20mb' }), async (req, res, next) => {
  if (!RUN_ID.test(req.params.run) || typeof req.body !== 'string') return res.status(400).json({ error: 'bad run id or body' });
  try {
    await fs.mkdir(tracesDir, { recursive: true });
    await fs.appendFile(path.join(tracesDir, req.params.run + '.ndjson'), req.body);
    res.status(204).end();
  } catch (err) { next(err); }
});

app.get('/api/traces', async (req, res, next) => {
  try {
    const names = (await fs.readdir(tracesDir).catch(() => [])).filter((n) => n.endsWith('.ndjson'));
    const runs = await Promise.all(names.map(async (n) => {
      const st = await fs.stat(path.join(tracesDir, n));
      return { run: n.slice(0, -7), bytes: st.size, modified: st.mtime.toISOString(), url: '/designer/traces/' + n };
    }));
    res.json(runs.sort((a, b) => b.modified.localeCompare(a.modified)));
  } catch (err) { next(err); }
});

app.get('/designer/overrides.js', async (req, res, next) => {
  try {
    res.type('application/javascript').set('Cache-Control', 'no-store');
    res.send('window.__DESIGNER_OVERRIDES = ' + JSON.stringify(await readOverrides()) + ';\n');
  } catch (err) { next(err); }
});

app.get(['/game/', '/game/index.html'], async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store').type('html').send(await gameIndex());
  } catch (err) { next(err); }
});

app.get('/', (req, res) => res.sendFile(path.join(designerDir, 'panel.html')));
app.use('/designer', express.static(designerDir, { index: false }));
app.use('/game', express.static(gameDir, { index: false }));

app.listen(PORT, HOST, () => {
  console.log(`A Dark Room designer on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  panel: /    tuned game alone: /game/    overrides: ${path.relative(gameDir, overridesFile)}`);
});
