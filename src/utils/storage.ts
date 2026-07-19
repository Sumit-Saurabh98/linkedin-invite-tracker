// Thin wrapper around chrome.storage.local for invitations + settings,
// plus the rolling-7-day computations the whole app relies on.

import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  WINDOW_MS,
  type Invitation,
  type Settings,
} from "./types";

export async function getInvitations(): Promise<Invitation[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.invitations);
  const list = result[STORAGE_KEYS.invitations];
  return Array.isArray(list) ? (list as Invitation[]) : [];
}

export async function setInvitations(list: Invitation[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.invitations]: list });
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.settings] ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

/** Add a new invitation record. Returns the created record. */
export async function addInvitation(
  data: Pick<Invitation, "name" | "profileUrl">,
): Promise<Invitation> {
  const invitation: Invitation = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sentAt: Date.now(),
    name: data.name,
    profileUrl: data.profileUrl,
  };
  const list = await getInvitations();
  list.push(invitation);
  await setInvitations(list);
  return invitation;
}

/**
 * Drop invitations older than the rolling window. Returns the pruned list.
 * Kept separate so both the background alarm and the popup can call it.
 */
export async function pruneExpired(now = Date.now()): Promise<Invitation[]> {
  const list = await getInvitations();
  const cutoff = now - WINDOW_MS;
  const kept = list.filter((inv) => inv.sentAt > cutoff);
  if (kept.length !== list.length) {
    await setInvitations(kept);
  }
  return kept;
}

/** A slot that frees up when an in-window invitation expires. */
export interface UpcomingSlot {
  /** Epoch ms when this invitation ages out of the 7-day window. */
  freesAt: number;
  invitation: Invitation;
}

export interface UsageStats {
  /** Invitations counted in the rolling window right now. */
  sentInWindow: number;
  /** The limit we compare against (detected limit wins over user's guess). */
  effectiveLimit: number;
  /** effectiveLimit - sentInWindow, clamped at 0. */
  remaining: number;
  /** remaining - reserved, clamped at 0. */
  usableRemaining: number;
  /** Invitations sent since local midnight today. */
  todayCount: number;
  /** Counts per local day for the last 7 days, oldest first. */
  dailyHistory: { date: string; count: number }[];
  /** When in-window invites expire, soonest first. */
  upcomingSlots: UpcomingSlot[];
  /** 0..1 fraction of the effective limit used. */
  usedFraction: number;
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Compute all derived usage numbers from a list + settings. Pure function. */
export function computeStats(
  invitations: Invitation[],
  settings: Settings,
  now = Date.now(),
): UsageStats {
  const cutoff = now - WINDOW_MS;
  const inWindow = invitations.filter((inv) => inv.sentAt > cutoff);

  const effectiveLimit = settings.detectedLimit ?? settings.weeklyLimit;
  const sentInWindow = inWindow.length;
  const remaining = Math.max(0, effectiveLimit - sentInWindow);
  const usableRemaining = Math.max(0, remaining - settings.reserved);

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = invitations.filter(
    (inv) => inv.sentAt >= todayStart.getTime(),
  ).length;

  // Daily history: last 7 local days, oldest first.
  const dailyHistory: { date: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;
    const count = invitations.filter(
      (inv) => inv.sentAt >= dayStart.getTime() && inv.sentAt < dayEnd,
    ).length;
    dailyHistory.push({ date: localDateKey(dayStart.getTime()), count });
  }

  const upcomingSlots: UpcomingSlot[] = inWindow
    .map((inv) => ({ freesAt: inv.sentAt + WINDOW_MS, invitation: inv }))
    .sort((a, b) => a.freesAt - b.freesAt);

  const usedFraction =
    effectiveLimit > 0 ? Math.min(1, sentInWindow / effectiveLimit) : 0;

  return {
    sentInWindow,
    effectiveLimit,
    remaining,
    usableRemaining,
    todayCount,
    dailyHistory,
    upcomingSlots,
    usedFraction,
  };
}
