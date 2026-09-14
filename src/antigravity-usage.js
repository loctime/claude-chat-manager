const { spawn } = require('child_process');
const { GEMINI_CMD: AGY_CMD } = require('./gemini-cmd');

function findBucket(group, windowName) {
  if (!group || !Array.isArray(group.buckets)) return null;
  return group.buckets.find(b => b.window === windowName || (b.id && b.id.includes(windowName))) || null;
}

function toUsageWindow(bucket, fallbackLabel) {
  if (!bucket || bucket.remaining_fraction == null) return null;
  const is5h = bucket.window === '5h' || (bucket.id && bucket.id.includes('5h'));
  const label = fallbackLabel || (is5h ? '5h' : 'Semana');
  const window = bucket.window || (is5h ? '5h' : 'weekly');
  const remaining = Number(bucket.remaining_fraction);
  const pct = Math.max(0, Math.min(100, (1 - remaining) * 100));
  return {
    label,
    window,
    pct,
    resetsAt: bucket.reset_time || null,
  };
}

function parseAntigravityUsage(result) {
  if (!result || result.status !== 'SUCCESS') {
    throw new Error(result?.error || 'Antigravity no pudo informar el uso');
  }
  const data = result.command?.data || {};
  const groups = data.groups || [];
  const geminiGroup = groups.find(g => /gemini/i.test(g.name)) || groups[0];
  const otherGroup = groups.find(g => g !== geminiGroup);

  const allBuckets = groups.flatMap(g => (g.buckets || []).map(b => ({ ...b, group: g.name })));
  const bucket5h = findBucket(geminiGroup, '5h') || allBuckets.find(b => b.window === '5h' || (b.id && b.id.includes('5h')));
  const bucketWeekly = findBucket(geminiGroup, 'weekly') || allBuckets.find(b => b.window === 'weekly' || (b.id && b.id.includes('weekly')));

  const plan = data.plan_tier || process.env.ANTIGRAVITY_PLAN || 'Pro';

  return {
    provider: 'antigravity',
    plan,
    primary: toUsageWindow(bucket5h, '5h'),
    secondary: toUsageWindow(bucketWeekly, 'Semana'),
    thirdParty: otherGroup ? {
      name: otherGroup.name,
      primary: toUsageWindow(findBucket(otherGroup, '5h'), '5h'),
      secondary: toUsageWindow(findBucket(otherGroup, 'weekly'), 'Semana'),
    } : null,
    description: data.description || '',
    fetchedAt: Date.now(),
  };
}

// `/usage` es un comando local de Antigravity: consulta el backend de cuotas,
// pero no inicia un agente ni consume tokens. Cache corto porque la UI ofrece
// refresco manual y los límites no necesitan polling agresivo.
class AntigravityUsageService {
  constructor({ command = AGY_CMD, spawnFn = spawn, cacheMs = 5 * 60 * 1000 } = {}) {
    this.command = command;
    this.spawnFn = spawnFn;
    this.cacheMs = cacheMs;
    this.cache = null;
    this.pending = null;
  }

  async get({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < this.cacheMs) return this.cache;
    if (!this.pending) this.pending = this._fetch().finally(() => { this.pending = null; });
    return this.pending;
  }

  _fetch() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnFn(this.command, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = '', stderr = '', settled = false;
      const finish = (err, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) reject(err);
        else {
          this.cache = data;
          resolve(data);
        }
      };
      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(new Error('Antigravity tardó demasiado en informar el uso'));
      }, 25_000);

      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', finish);
      child.on('close', code => {
        let result;
        try {
          result = JSON.parse(stdout.trim());
        } catch {
          finish(new Error(stderr.trim() || `Antigravity devolvió una respuesta inválida (${code})`));
          return;
        }
        try {
          finish(null, parseAntigravityUsage(result));
        } catch (err) {
          finish(new Error(err.message || stderr.trim() || 'Antigravity no pudo informar el uso'));
        }
      });
    });
  }
}

module.exports = { AntigravityUsageService, parseAntigravityUsage, toUsageWindow, findBucket };
