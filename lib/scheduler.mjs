import { open, readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON } from './settings.mjs';
import { attemptHistoryLimit } from './attempt-history.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const empty = () => ({ active: [], queue: [], cooldownUntil: 0, attempts: 0 });

// Retiring hosts share scheduling state and bounded response-structure records.
export class Scheduler {
  constructor(settings) {
    this.settings = settings;
    this.file = join(settings.directory, 'scheduler.json');
    this.lock = join(settings.directory, 'scheduler.lock');
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
        let state;
        try { state = JSON.parse(await readFile(this.file, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; state = empty(); }
        state.active = state.active.filter(x => alive(x.pid));
        state.queue = state.queue.filter(x => alive(x.pid) && x.deadline > Date.now());
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
    try {
      for (;;) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) return null;
        const limit = (await this.settings.read()).maxConcurrency;
        granted = await this.transaction(state => {
          if (!state.queue.some(x => x.token === token)) state.queue.push({ token, pid: process.pid, deadline });
          if (state.queue[0]?.token !== token || state.active.length >= limit || Date.now() < state.cooldownUntil) return false;
          state.queue.shift();
          state.active.push({ token, pid: process.pid });
          state.attempts++;
          return true;
        }, signal);
        if (granted) return async record => this.transaction(state => {
          state.active = state.active.filter(x => x.token !== token);
          if (record) state.recent = [record, ...(state.recent || [])].slice(0, attemptHistoryLimit);
        });
        await delay(Math.min(75, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    } finally {
      if (!granted) await this.transaction(state => { state.queue = state.queue.filter(x => x.token !== token); });
    }
  }

  cooldown(until) {
    return this.transaction(state => {
      state.cooldownUntil = Math.max(state.cooldownUntil, until);
      return state.cooldownUntil;
    });
  }
  snapshot() {
    return this.transaction(state => ({ active: state.active.length, queued: state.queue.length, cooldownUntil: state.cooldownUntil, attempts: state.attempts, recentAttempts: state.recent ?? [] }));
  }
}
