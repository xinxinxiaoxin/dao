import { open, readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON } from './settings.mjs';
import { attemptHistoryLimit } from './attempt-history.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const empty = () => ({ active: [], queue: [], cooldownUntil: 0, attempts: 0 });
const ready = (state, token, limit) => state.queue[0]?.token === token && state.active.length < limit && Date.now() >= state.cooldownUntil;

// Retiring hosts share scheduling state and bounded response-structure records.
export class Scheduler {
  constructor(settings) {
    this.settings = settings;
    this.file = join(settings.directory, 'scheduler.json');
    this.lock = join(settings.directory, 'scheduler.lock');
  }

  async readState() {
    let state;
    try { state = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return empty(); }
    state.active = state.active.filter(entry => alive(entry.pid));
    state.queue = state.queue.filter(entry => entry.deadline > Date.now() && alive(entry.pid));
    return state;
  }

  async transaction(fn, signal) {
    for (;;) {
      signal?.throwIfAborted();
      let handle;
      try { handle = await open(this.lock, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const owner = Number(await readFile(this.lock, 'utf8'));
          const age = Date.now() - (await stat(this.lock)).mtimeMs;
          if ((owner && !alive(owner)) || (!owner && age > 10000)) await unlink(this.lock);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await delay(20, undefined, { signal });
        continue;
      }
      try {
        await handle.writeFile(String(process.pid));
        const state = await this.readState();
        const result = await fn(state);
        await atomicJSON(this.file, state);
        return result;
      } finally {
        await handle.close();
        await unlink(this.lock);
      }
    }
  }

  async acquire(signal, deadline) {
    const token = randomUUID();
    let granted = false;
    let queued = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) return null;
        if (queued) {
          const state = await this.readState();
          if (!ready(state, token, (await this.settings.read()).maxConcurrency)) {
            const now = Date.now();
            await delay(Math.max(1, Math.min(deadline - now, Math.max(75, state.cooldownUntil - now))), undefined, { signal });
            continue;
          }
        }
        granted = await this.transaction(async state => {
          const limit = (await this.settings.read()).maxConcurrency;
          signal.throwIfAborted();
          if (Date.now() >= deadline) return false;
          if (!queued) { state.queue.push({ token, pid: process.pid, deadline }); queued = true; }
          if (!ready(state, token, limit)) return false;
          state.queue.shift();
          state.active.push({ token, pid: process.pid });
          state.attempts++;
          return true;
        }, signal);
        if (granted) return async record => this.transaction(state => {
          state.active = state.active.filter(x => x.token !== token);
          if (record) state.recent = [record, ...(state.recent || [])].slice(0, attemptHistoryLimit);
        });
      }
    } finally {
      if (queued && !granted) await this.transaction(state => { state.queue = state.queue.filter(x => x.token !== token); });
    }
  }

  cooldown(until) {
    return this.transaction(state => {
      state.cooldownUntil = Math.max(state.cooldownUntil, until);
      return state.cooldownUntil;
    });
  }
  finishRetry(requestId, { attempt, startedAt }) {
    return this.transaction(state => {
      const previous = state.recent?.find(record => record.requestId === requestId && record.attempt === attempt);
      if (!previous) return;
      if (startedAt === undefined) previous.retrySkipped = true;
      else previous.retryStartedAt = startedAt;
    });
  }
  async snapshot() {
    const state = await this.readState();
    return { active: state.active.length, queued: state.queue.length, cooldownUntil: state.cooldownUntil, attempts: state.attempts, recentAttempts: state.recent ?? [] };
  }
}
