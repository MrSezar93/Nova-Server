/**
 * Data layer.
 *
 * Everything is persisted in a single KV namespace as a handful of JSON
 * documents (the panel is a single-admin tool, so a document store keeps the
 * implementation small and the KV write/read counts low).
 *
 * KV is eventually consistent: writes may take up to ~60s to be visible in
 * other Cloudflare locations. To keep the panel responsive we keep a short
 * lived in-isolate cache that is refreshed on every write, so the admin always
 * sees their own changes immediately.
 */

import { randomId } from "./b64";
import {
  DEFAULT_SETTINGS,
  type AuthRecord,
  type ClientRecord,
  type Identity,
  type LogEntry,
  type PanelSettings,
  type RegistrationCounter,
} from "../types";

const KEYS = {
  settings: "data:settings:v1",
  auth: "data:auth:v1",
  identities: "data:identities:v1",
  clients: "data:clients:v1",
  logs: "data:logs:v1",
  limiter: "data:limiter:v1",
} as const;

const CACHE_TTL_MS = 4_000;
const MAX_LOGS = 120;

interface CacheEntry {
  value: unknown;
  at: number;
}

/** Isolate-scoped cache. Survives between requests of the same isolate. */
const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { value, at: Date.now() });
}

/** Fallback storage used when no KV binding is configured (dev / preview). */
const memoryStore = new Map<string, unknown>();

export interface StoreInit {
  kv?: KVNamespace;
}

export class Store {
  readonly kv?: KVNamespace;
  readonly persistent: boolean;

  constructor(init: StoreInit) {
    this.kv = init.kv;
    this.persistent = Boolean(init.kv);
  }

  private async readRaw<T>(key: string, fallback: T): Promise<T> {
    const cached = cacheGet<T>(key);
    if (cached !== undefined) return cached;
    try {
      if (this.kv) {
        const value = await this.kv.get<T>(key, "json");
        if (value !== null && value !== undefined) {
          cacheSet(key, value);
          return value as T;
        }
      } else if (memoryStore.has(key)) {
        const value = memoryStore.get(key) as T;
        cacheSet(key, value);
        return value;
      }
    } catch (error) {
      console.error("kv read failed", key, error);
    }
    cacheSet(key, fallback);
    return fallback;
  }

  private async writeRaw<T>(key: string, value: T): Promise<void> {
    cacheSet(key, value);
    try {
      if (this.kv) {
        await this.kv.put(key, JSON.stringify(value));
      } else {
        memoryStore.set(key, value);
      }
    } catch (error) {
      console.error("kv write failed", key, error);
      throw new Error("ذخیره‌سازی KV با خطا مواجه شد. اتصال KV را بررسی کنید.");
    }
  }

  /* ------------------------------- settings ------------------------------- */

  async getSettings(): Promise<PanelSettings> {
    const stored = await this.readRaw<Partial<PanelSettings>>(KEYS.settings, {});
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  async saveSettings(settings: PanelSettings): Promise<PanelSettings> {
    await this.writeRaw(KEYS.settings, settings);
    return settings;
  }

  async patchSettings(patch: Partial<PanelSettings>): Promise<PanelSettings> {
    const current = await this.getSettings();
    return this.saveSettings({ ...current, ...patch });
  }

  /* --------------------------------- auth --------------------------------- */

  async getAuth(): Promise<AuthRecord | null> {
    const value = await this.readRaw<AuthRecord | null>(KEYS.auth, null);
    return value && value.hash ? value : null;
  }

  async saveAuth(record: AuthRecord): Promise<void> {
    await this.writeRaw(KEYS.auth, record);
  }

  /* ------------------------------ identities ------------------------------ */

  async listIdentities(): Promise<Identity[]> {
    const list = await this.readRaw<Identity[]>(KEYS.identities, []);
    if (!Array.isArray(list)) return [];
    return list.filter(Boolean).map((identity) => ({ ...identity }));
  }

  async getIdentity(id: string): Promise<Identity | null> {
    const list = await this.listIdentities();
    return list.find((identity) => identity.id === id) ?? null;
  }

  async saveIdentity(identity: Identity): Promise<Identity> {
    const list = await this.listIdentities();
    identity.updatedAt = Date.now();
    const index = list.findIndex((item) => item.id === identity.id);
    if (index >= 0) list[index] = identity;
    else list.push(identity);
    await this.writeRaw(KEYS.identities, list);
    return identity;
  }

  async deleteIdentity(id: string): Promise<void> {
    const list = await this.listIdentities();
    await this.writeRaw(
      KEYS.identities,
      list.filter((item) => item.id !== id),
    );
  }

  /* -------------------------------- clients ------------------------------- */

  async listClients(): Promise<ClientRecord[]> {
    const list = await this.readRaw<ClientRecord[]>(KEYS.clients, []);
    if (!Array.isArray(list)) return [];
    return list.filter(Boolean).map((client) => ({ ...client }));
  }

  async getClient(id: string): Promise<ClientRecord | null> {
    const list = await this.listClients();
    return list.find((client) => client.id === id) ?? null;
  }

  async getClientByToken(token: string): Promise<ClientRecord | null> {
    const list = await this.listClients();
    return list.find((client) => client.shareToken === token) ?? null;
  }

  async saveClient(client: ClientRecord): Promise<ClientRecord> {
    const list = await this.listClients();
    const index = list.findIndex((item) => item.id === client.id);
    if (index >= 0) list[index] = client;
    else list.push(client);
    await this.writeRaw(KEYS.clients, list);
    return client;
  }

  async deleteClient(id: string): Promise<void> {
    const list = await this.listClients();
    await this.writeRaw(
      KEYS.clients,
      list.filter((item) => item.id !== id),
    );
  }

  /* --------------------------------- logs --------------------------------- */

  async listLogs(): Promise<LogEntry[]> {
    const list = await this.readRaw<LogEntry[]>(KEYS.logs, []);
    return Array.isArray(list) ? list : [];
  }

  async addLog(entry: Omit<LogEntry, "id" | "at"> & { at?: number }): Promise<void> {
    const logs = await this.listLogs();
    logs.unshift({ id: randomId(6), at: entry.at ?? Date.now(), ...entry });
    await this.writeRaw(KEYS.logs, logs.slice(0, MAX_LOGS));
  }

  async clearLogs(): Promise<void> {
    await this.writeRaw(KEYS.logs, []);
  }

  /* ------------------------------- counters ------------------------------- */

  async readCounter(): Promise<RegistrationCounter> {
    return this.readRaw<RegistrationCounter>(KEYS.limiter, { windowStart: 0, count: 0 });
  }

  async consumeRegistrationQuota(limitPerHour: number): Promise<{ allowed: boolean; retryAfter: number }> {
    const now = Date.now();
    const counter = await this.readCounter();
    const windowMs = 60 * 60 * 1000;
    const fresh = now - counter.windowStart > windowMs;
    const next: RegistrationCounter = fresh
      ? { windowStart: now, count: 1 }
      : { windowStart: counter.windowStart, count: counter.count + 1 };
    if (!fresh && next.count > limitPerHour) {
      return { allowed: false, retryAfter: Math.ceil((counter.windowStart + windowMs - now) / 1000) };
    }
    await this.writeRaw(KEYS.limiter, next);
    return { allowed: true, retryAfter: 0 };
  }

  /* --------------------------- generic helpers ---------------------------- */

  /** Generic JSON document access (used for throttle counters and misc state). */
  async getJson<T>(key: string, fallback: T): Promise<T> {
    return this.readRaw<T>(`data:${key}`, fallback);
  }

  async setJson<T>(key: string, value: T): Promise<void> {
    await this.writeRaw(`data:${key}`, value);
  }

  /** Clears the isolate cache — used by tests. */
  static clearCache(): void {
    cache.clear();
  }
}
