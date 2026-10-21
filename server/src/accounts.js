/**
 * AegisCode — accounts and sessions (Phase Three)
 *
 * Zero dependencies: scrypt from the standard node:crypto.
 *
 * Principles:
 *  - The password is stored as a scrypt hash with a random per-account salt —
 *    never stored in plain form.
 *  - Comparison via timingSafeEqual (constant time).
 *  - Session tokens are 64 random bytes — unguessable.
 *  - Sessions expire automatically after 24 hours.
 *  - User isolation is enforced in the server layer on every route by `owner`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ACCOUNTS_FILE = 'accounts.json';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return scryptSync(password, salt, 64).toString('hex');
}

export class AccountStore {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, ACCOUNTS_FILE);
    /** @type {Map<string, {salt:string, hash:string, created_at:string}>} */
    this.users = new Map();
    /** @type {Map<string, {username:string, created_at:string}>} */
    this.sessions = new Map();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [username, rec] of Object.entries(parsed.users ?? {})) {
        this.users.set(username, rec);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  async _persist() {
    const obj = { users: Object.fromEntries(this.users) };
    const tmp = `${this.path}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }

  /**
   * Creates a new account.
   * @returns {Promise<{ok:boolean, error?:string, username?:string}>}
   */
  async register(username, password) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return { ok: false, error: 'Username: 3–32 characters, letters, digits and " _ - ." only, starting with a letter or digit.' };
    }
    if (typeof password !== 'string' || password.length < 8) {
      return { ok: false, error: 'Password: at least 8 characters.' };
    }
    if (this.users.has(username)) {
      return { ok: false, error: 'Username is taken.' };
    }

    const salt = randomBytes(16).toString('hex');
    this.users.set(username, {
      salt,
      hash: hashPassword(password, salt),
      created_at: new Date().toISOString(),
    });
    await this._persist();
    return { ok: true, username };
  }

  /**
   * Validates credentials and creates a session.
   * @returns {Promise<{ok:boolean, error?:string, token?:string, username?:string}>}
   */
  async login(username, password) {
    const rec = this.users.get(typeof username === 'string' ? username : '');
    if (!rec) {
      // Dummy comparison against timing: even a missing account leaks nothing
      // through a time difference.
      hashPassword(String(password ?? ''), '00'.repeat(16));
      return { ok: false, error: 'Invalid credentials.' };
    }
    const candidate = hashPassword(String(password ?? ''), rec.salt);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(rec.hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, error: 'Invalid credentials.' };
    }

    const token = randomBytes(64).toString('hex');
    this.sessions.set(token, { username, created_at: new Date().toISOString() });
    return { ok: true, token, username };
  }

  /** Invalidates a session (logout). */
  logout(token) {
    return this.sessions.delete(token);
  }

  /**
   * Validates a session token.
   * @returns {{username:string}|null}
   */
  authenticate(token) {
    if (typeof token !== 'string' || token === '') return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() - Date.parse(session.created_at) > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return null;
    }
    return { username: session.username };
  }
}
