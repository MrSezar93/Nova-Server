/** Password storage, sessions, API keys and the login throttle. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPassword,
  createAuthRecord,
  createSessionToken,
  generateApiKey,
  verifyPassword,
  verifySessionToken,
} from "../src/lib/auth";
import { Store } from "../src/lib/store";
import { makeEnv } from "./helpers";

test("passwords are hashed with a salt and verified in constant time", async () => {
  const env = makeEnv();
  const record = await createAuthRecord("correct horse battery", env);
  assert.notEqual(record.hash, "correct horse battery");
  assert.equal(record.hash.length, 64);
  assert.ok(await verifyPassword("correct horse battery", record));
  assert.ok(!(await verifyPassword("wrong password", record)));

  const other = await createAuthRecord("correct horse battery", env);
  assert.notEqual(record.hash, other.hash, "a fresh salt must change the hash");
});

test("PANEL_PASSWORD takes precedence over the stored record", async () => {
  const store = new Store({});
  const env = makeEnv({ PANEL_PASSWORD: "secret-from-env" });
  assert.deepEqual(await checkPassword("secret-from-env", env, store), { ok: true, configured: true });
  assert.equal((await checkPassword("nope", env, store)).ok, false);

  // without PANEL_PASSWORD the KV-stored hash is used instead
  const record = await createAuthRecord("stored-password", makeEnv());
  await store.saveAuth(record);
  const withoutEnvPassword = makeEnv();
  assert.equal((await checkPassword("stored-password", withoutEnvPassword, store)).ok, true);
  assert.equal((await checkPassword("wrong", withoutEnvPassword, store)).ok, false);
  assert.equal((await checkPassword("stored-password", env, store)).ok, false, "env password wins");
});

test("sessions are signed, expire and reject tampering", async () => {
  const secret = "unit-test-secret";
  const token = await createSessionToken(secret, 60);
  const payload = await verifySessionToken(secret, token);
  assert.ok(payload);
  assert.equal(payload.sub, "admin");

  assert.equal(await verifySessionToken(secret, `${token}x`), null);
  assert.equal(await verifySessionToken("other-secret", token), null);
  assert.equal(await verifySessionToken(secret, "garbage"), null);

  const expired = await createSessionToken(secret, -5);
  assert.equal(await verifySessionToken(secret, expired), null);
});

test("api keys look random and unique", () => {
  const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));
  assert.equal(keys.size, 20);
  for (const key of keys) assert.match(key, /^nw_[A-Za-z0-9_-]{32}$/);
});

test("login throttle blocks after too many failures", async () => {
  const store = new Store({});
  const { registerFailedLogin, clearFailedLogins } = await import("../src/lib/auth");
  let blocked = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await registerFailedLogin(store, "1.2.3.4", 5);
    blocked = blocked || result.blocked;
  }
  assert.ok(blocked, "should block after the limit");
  await clearFailedLogins(store, "1.2.3.4");
  const after = await registerFailedLogin(store, "1.2.3.4", 5);
  assert.equal(after.blocked, false);
});
