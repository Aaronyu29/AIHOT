import { useSyncExternalStore } from "react";
import { readRaw, writeRaw } from "../../../apps/web/app/lib/local-state.ts";

export const WATCHLIST_KEY = "funding-project-watchlist-v1";
const LIMIT = 100;
export interface WatchedProject { id: number; name: string }
const EMPTY: WatchedProject[] = [];
const listeners = new Set<() => void>();
let previousRaw: string | null | undefined;
let snapshot: WatchedProject[] = EMPTY;

function decode(raw: string | null): WatchedProject[] | null {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const seen = new Set<number>();
    return value.filter((entry): entry is WatchedProject => {
      if (!entry || typeof entry !== "object") return false;
      const { id, name } = entry as Partial<WatchedProject>;
      if (!Number.isSafeInteger(id) || id! <= 0 || typeof name !== "string" || !name.trim() || seen.has(id!)) return false;
      seen.add(id!);
      return true;
    }).slice(0, LIMIT).map(({ id, name }) => ({ id, name: name.slice(0, 200) }));
  } catch {
    return null;
  }
}

export function getWatchlist(): WatchedProject[] {
  const raw = readRaw(WATCHLIST_KEY);
  if (raw !== previousRaw) {
    previousRaw = raw;
    snapshot = decode(raw) ?? EMPTY;
  }
  return snapshot;
}

function notify() {
  previousRaw = undefined;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === WATCHLIST_KEY) notify();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export const useWatchlist = () => useSyncExternalStore(subscribe, getWatchlist, () => EMPTY);

/** Always merge the newest browser value; a second tab may have changed it since this page rendered. */
export function toggleWatch(project: WatchedProject): string | null {
  if (!Number.isSafeInteger(project.id) || project.id <= 0 || !project.name.trim()) return "项目暂时无法关注。";
  const current = decode(readRaw(WATCHLIST_KEY));
  if (!current) return "关注记录暂时无法读取，原有数据已保留。";
  const exists = current.some((item) => item.id === project.id);
  if (!exists && current.length >= LIMIT) return `最多关注 ${LIMIT} 个项目，请先移除一些项目。`;
  const next = exists ? current.filter((item) => item.id !== project.id) : [{ id: project.id, name: project.name.slice(0, 200) }, ...current];
  if (!writeRaw(WATCHLIST_KEY, JSON.stringify(next))) return "浏览器未能保存关注，请检查存储权限或剩余空间。";
  notify();
  return null;
}
