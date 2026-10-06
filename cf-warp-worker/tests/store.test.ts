/** KV-backed document store. */
import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/lib/store";
import { DEFAULT_SETTINGS } from "../src/types";
import { FakeKV, makeEnv } from "./helpers";

test("settings merge with defaults and persist", async () => {
  const env = makeEnv();
  const store = new Store({ kv: env.WARP_KV });
  const settings = await store.getSettings();
  assert.equal(settings.mtu, DEFAULT_SETTINGS.mtu);
  assert.equal(settings.identityPolicy, "pool");

  await store.patchSettings({ mtu: 1400, title: "My Panel" });
  Store.clearCache();

  const reloaded = await new Store({ kv: env.WARP_KV }).getSettings();
  assert.equal(reloaded.mtu, 1400);
  assert.equal(reloaded.title, "My Panel");
  assert.equal(reloaded.dns.length, 4);
});

test("identities and clients round-trip", async () => {
  const env = makeEnv();
  const store = new Store({ kv: env.WARP_KV });
  await store.saveIdentity({
    id: "id-1",
    name: "first",
    source: "api",
    privateKey: "a",
    publicKey: "b",
    peerPublicKey: "c",
    createdAt: 1,
    updatedAt: 1,
  });
  await store.saveIdentity({
    id: "id-2",
    name: "second",
    source: "import",
    privateKey: "a",
    publicKey: "b",
    peerPublicKey: "c",
    createdAt: 1,
    updatedAt: 1,
  });
  const identities = await store.listIdentities();
  assert.equal(identities.length, 2);
  assert.equal((await store.getIdentity("id-2"))?.name, "second");

  await store.saveClient({
    id: "c-1",
    name: "phone",
    identityId: "id-1",
    shareToken: "tok",
    enabled: true,
    format: "wg",
    options: {},
    createdAt: 1,
    views: 0,
  });
  assert.equal((await store.getClientByToken("tok"))?.name, "phone");

  await store.deleteClient("c-1");
  assert.equal(await store.getClient("c-1"), null);
  await store.deleteIdentity("id-1");
  assert.equal(await store.getIdentity("id-1"), null);
});

test("logs are capped and ordered newest first", async () => {
  const env = makeEnv();
  const store = new Store({ kv: env.WARP_KV });
  for (let i = 0; i < 130; i++) {
    await store.addLog({ level: "info", message: `entry ${i}` });
  }
  const logs = await store.listLogs();
  assert.equal(logs.length, 120);
  assert.equal(logs[0].message, "entry 129");
  await store.clearLogs();
  assert.equal((await store.listLogs()).length, 0);
});

test("registration quota resets after the window", async () => {
  const env = makeEnv();
  const store = new Store({ kv: env.WARP_KV });
  for (let i = 0; i < 3; i++) {
    assert.equal((await store.consumeRegistrationQuota(3)).allowed, true);
  }
  const blocked = await store.consumeRegistrationQuota(3);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 3600);

  // simulate an expired window
  const kv = env.__kv as FakeKV;
  const key = [...kv.store.keys()].find((entry) => entry.includes("limiter"));
  assert.ok(key);
  const stored = JSON.parse(kv.store.get(key as string) as string) as { windowStart: number; count: number };
  kv.store.set(key as string, JSON.stringify({ ...stored, windowStart: Date.now() - 3_700_000 }));
  Store.clearCache();
  assert.equal((await store.consumeRegistrationQuota(3)).allowed, true);
});

test("works without a KV binding (in-memory fallback)", async () => {
  const store = new Store({});
  assert.equal(store.persistent, false);
  await store.patchSettings({ title: "memory" });
  assert.equal((await store.getSettings()).title, "memory");
});
