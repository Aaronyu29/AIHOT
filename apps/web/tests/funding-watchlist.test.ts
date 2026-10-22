import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getWatchlist, toggleWatch, WATCHLIST_KEY } from "../../../modules/rootdata/web/watchlist.ts";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });

function reader(raw?: string) {
  const values = new Map<string, string>(raw === undefined ? [] : [[WATCHLIST_KEY, raw]]);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } } });
  return values;
}

test("following merges a newer tab's changes and preserves stable read snapshots", () => {
  const values = reader();
  assert.equal(toggleWatch({ id: 1, name: "First" }), null);
  const before = getWatchlist();
  assert.strictEqual(getWatchlist(), before);
  values.set(WATCHLIST_KEY, JSON.stringify([{ id: 2, name: "Second tab" }, ...before]));
  assert.equal(toggleWatch({ id: 3, name: "Third" }), null);
  assert.deepEqual(getWatchlist().map((item) => item.id), [3, 2, 1]);
  assert.equal(toggleWatch({ id: 2, name: "Second tab" }), null);
  assert.deepEqual(getWatchlist().map((item) => item.id), [3, 1]);
});

test("corrupt data and denied browser storage never report a saved follow", () => {
  const values = reader("broken original");
  assert.ok(toggleWatch({ id: 1, name: "New" }));
  assert.equal(values.get(WATCHLIST_KEY), "broken original");
  reader();
  window.localStorage.setItem = () => { throw new Error("denied"); };
  assert.ok(toggleWatch({ id: 1, name: "New" }));
});

test("following limit can still remove existing entries and invalid stored IDs are ignored", () => {
  reader(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Project ${index}` }))));
  assert.ok(toggleWatch({ id: 101, name: "Overflow" }));
  assert.equal(toggleWatch({ id: 1, name: "Project 0" }), null);
  assert.equal(getWatchlist().length, 99);
  reader(JSON.stringify([{ id: -1, name: "bad" }, { id: 7, name: "Kept" }, { id: 7, name: "Duplicate" }]));
  assert.deepEqual(getWatchlist(), [{ id: 7, name: "Kept" }]);
});
