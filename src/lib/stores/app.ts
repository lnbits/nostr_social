import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { writable, type Readable } from 'svelte/store';
import {
  cacheEvents,
  cacheEventStats,
  cacheDeletedEventIds,
  cacheDeletionRequest,
  cacheOwnAction,
  cacheDirectMessages,
  cacheNotifications,
  clearEventCache,
  getCachedDirectMessages,
  getCachedDeletedEventIds,
  getCachedEvents,
  getCachedEventStats,
  getCachedOwnActions,
  getCachedHashtagEvents,
  getCachedNotifications,
  getCachedProfileEvents,
  getCachedProfiles,
  removeCachedOwnAction,
  type CachedOwnAction
} from '$lib/nostr/cache';
import { defaultCustomFeedSettings, defaultGlobalFeedAuthors, defaultGlobalFeedRelays, defaultGuestNip05, defaultProfileRelays, defaultRelays, globalFeedCuratorPubkey, globalFeedHashtags, keywordsForInterests } from '$lib/nostr/config';
import { appPath } from '$lib/paths';
import { markRelaysOffline, markRelaysOnline, syncRelayStatus } from '$lib/stores/relayStatus';
import { insertTimelineItems, timelineCursor, uniqueFreshItems } from '$lib/timeline/window';
import { mergeDirectMessages } from './directMessages';
import {
  activeRelayUrls,
  connectedRelayUrls,
  createGuestSession,
  dedupeEvents,
  fetchDirectMessages,
  fetchContactListDetails,
  fetchFeed,
  fetchFriendsOfFriends,
  fetchEventStats,
  fetchDeletedEventIdsForEvents,
  fetchMuteList,
  fetchProfileEvents,
  fetchProfiles,
  fetchUserEventActions,
  fetchNotifications,
  fetchRelayInfoDocuments,
  fetchRelayListMetadata,
  fetchThreadReplies,
  filterSpam,
  eventStatsFromEvents,
  limitCryptoTopicDensity,
  limitConsecutiveAuthors,
  loginWithBunker,
  loginWithNip07,
  loginWithPrivateKey,
  normalizeRelayUrl,
  publishContactList,
  publishDeletion,
  publishMuteList,
  publishNote,
  publishProfile,
  publishReaction,
  publishRelayListMetadata,
  publishReport,
  publishRepost,
  publishSignedNostrEvent,
  publishNip17DirectMessage,
  parseRepostContent,
  resetRelayBackoff,
  resolveNip05Profile,
  resolvePubkeyIdentifier,
  subscribeDirectMessages,
  subscribeEventStats,
  subscribeFeed,
  subscribeNotifications,
  signNote,
  temporarilyUnavailableRelayUrls,
  topLevelFeedEvents
} from '$lib/nostr/client';
import { clearPomegranateAuth, importNsecIntoPomegranate, loginWithPomegranateProvider, type PomegranateLoginProvider } from '$lib/nostr/pomegranateAuth';
import { eventHasImgurUrl } from '$lib/nostr/media';
import { clearNativePrivateKeySession, persistNativePrivateKeySession, readNativePrivateKeySession } from '$lib/nativeSecureSession';
import { setupNativeLocalNotifications, showNativeNotificationForItem } from '$lib/nativeLocalNotifications';
import { savePrefetchedThreadReplies } from '$lib/stores/threadSeed';
import type { ContactListDetails, ContactListItem, CustomFeedSettings, DirectMessage, EventStats, FeedMode, LoginMode, NostrEvent, NotificationItem, Profile, RelayState, Session } from '$lib/nostr/types';

const sessionStorageKey = 'nostr-session';
const contactListStorageKey = 'nostr-contact-list';
const feedModeStorageKey = 'nostr-feed-mode';
const onboardingStorageKey = 'nostr-onboarding-complete';
const customFeedStorageKey = 'nostr-custom-feed-settings';
const notificationSeenStorageKey = 'nostr-notifications-seen-at';
const messageSeenStorageKey = 'nostr-messages-seen-at';
const pendingPublishStorageKey = 'nostr-pending-publishes';
const initialFeedLimit = 24;
const pageFeedLimit = 36;
const maxFeedEvents = 600;
const maxPendingNewerEvents = 600;
const maxCachedOlderEvents = 600;
const cachedFeedBufferLimit = maxFeedEvents + maxPendingNewerEvents + maxCachedOlderEvents;
const maxInMemoryProfiles = 1200;
const maxInMemoryStats = 3000;
const maxInMemoryOwnActions = 2000;
const maxInMemoryDeletedIds = 3000;
const maxSeenLiveEvents = 1500;
const maxSeenLiveActions = 4000;
const maxRequestedStats = 2000;
const olderFetchBatchLimit = 160;
const olderFetchTarget = pageFeedLimit;
const olderFetchMaxAttempts = 5;
const olderFetchEmptyAttemptLimit = 2;
const feedRecentWindowSeconds = 60 * 60 * 24 * 30;
const globalFeedCachedWindowSeconds = 60 * 60 * 24 * 3;
const olderFetchPageWindowSeconds = 60 * 60 * 24 * 30;
const threadPrefetchReplyLimit = 10;
const threadPrefetchCooldownMs = 5 * 60 * 1000;
const maxThreadPrefetchConcurrent = 2;
const deletionCheckCooldownMs = 5 * 60 * 1000;
const maxNotificationItems = 160;
const networkRecoveryCooldownMs = 12_000;
const networkKeepaliveMs = 45_000;
const publishRetryBaseMs = 2500;
const publishRetryMaxMs = 45_000;
const publishRetryLimit = 6;
const maxPendingPublishes = 50;

const initialSession = browser ? readStoredSession() : null;
const initialStoredContacts = browser && initialSession ? readStoredContactList(initialSession.pubkey) : undefined;
const initialStoredFeedMode = browser && initialSession ? readStoredFeedMode(initialSession.pubkey) : undefined;
const initialFeedMode = initialStoredFeedMode ?? 'global';
const initialCustomFeedSettings = browser ? readStoredCustomFeedSettings() : defaultCustomFeedSettings;

export const feedMode = writable<FeedMode>(initialFeedMode);
export const events = writable<NostrEvent[]>([]);
export const pendingNewerEvents = writable<NostrEvent[]>([]);
export const profiles = writable<Record<string, Profile>>({});
export const relays = writable<RelayState[]>(defaultRelays);
export const session = writable<Session | null>(initialSession);
export const follows = writable<string[]>(initialStoredContacts?.pubkeys ?? []);
export const mutedPubkeys = writable<string[]>([]);
export const customFeedSettings = writable<CustomFeedSettings>(initialCustomFeedSettings);
export const activeHashtag = writable<string>('');
export const online = writable(true);
export const notifications = writable<NotificationItem[]>([]);
export const directMessages = writable<DirectMessage[]>([]);
export const unreadNotificationCount = writable(0);
export const unreadMessageCount = writable(0);
export const activeMessagePeer = writable<string>('');
export const eventStats = writable<Record<string, EventStats>>({});
export const likedEvents = writable<Set<string>>(new Set());
export const repostedEvents = writable<Set<string>>(new Set());
export const deletedEventIds = writable<Set<string>>(new Set());
export const editedEvents = writable<Record<string, NostrEvent>>({});
export const loadingFeed = writable(false);
export const loadingNewerFeed = writable(false);
export const loadingMessages = writable(false);
export const loadingNotifications = writable(false);
export const loadingMoreFeed = writable(false);
export const hasMoreFeed = writable(true);
export const composerOpen = writable(false);
export const loginDialogOpen = writable(false);
export const onboardingDialogOpen = writable(false);
export const replyTarget = writable<NostrEvent | null>(null);
export const editTarget = writable<NostrEvent | null>(null);
export const quoteTarget = writable<NostrEvent | null>(null);

export function statsForEvent(id: string): Readable<EventStats> {
  return selectedStore(eventStats, (items) => items[id] ?? emptyStats(), statsEqual);
}

export function likedStateForEvent(id: string): Readable<boolean> {
  return selectedStore(likedEvents, (items) => items.has(id));
}

export function repostedStateForEvent(id: string): Readable<boolean> {
  return selectedStore(repostedEvents, (items) => items.has(id));
}

export function displayEventForEvent(event: NostrEvent): Readable<NostrEvent> {
  return selectedStore(editedEvents, (items) => items[event.id] ?? event);
}

export function mergeProfileRecords(existing: Record<string, Profile>, nextProfiles: Profile[]) {
  const merged = { ...existing };
  for (const profile of nextProfiles) {
    const current = merged[profile.pubkey];
    if (!current || (profile.updated_at ?? 0) >= (current.updated_at ?? 0)) {
      merged[profile.pubkey] = profile;
    }
  }
  return pruneProfileRecords(merged, nextProfiles.map((profile) => profile.pubkey));
}

function pruneProfileRecords(items: Record<string, Profile>, priorityPubkeys: string[] = []) {
  const entries = Object.entries(items);
  if (entries.length <= maxInMemoryProfiles) return items;

  const priority = new Set(
    [
      ...priorityPubkeys,
      currentSessionValue?.pubkey ?? '',
      ...currentFollows,
      ...currentContactItems.map((item) => item.pubkey),
      ...getStoreSnapshot(events).map((event) => event.pubkey),
      ...getStoreSnapshot(pendingNewerEvents).map((event) => event.pubkey),
      ...cachedOlderEvents.slice(0, 120).map((event) => event.pubkey),
      ...currentNotifications.map((item) => item.actor),
      ...currentDirectMessages.map((message) => message.peer)
    ].filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey))
  );

  const sorted = entries.sort(([a, aProfile], [b, bProfile]) => {
    const priorityDelta = Number(priority.has(b)) - Number(priority.has(a));
    if (priorityDelta) return priorityDelta;
    return (bProfile.updated_at ?? 0) - (aProfile.updated_at ?? 0);
  });

  return Object.fromEntries(sorted.slice(0, maxInMemoryProfiles));
}

let currentRelays = defaultRelays;
let currentFollows: string[] = initialStoredContacts?.pubkeys ?? [];
let currentMutedPubkeys = new Set<string>();
let currentSettings = defaultCustomFeedSettings;
let currentMode: FeedMode = initialFeedMode;
let currentHashtag = '';
let currentSessionValue: Session | null = initialSession;
let currentGlobalFeedAuthors: string[] = defaultGlobalFeedAuthors;
let currentNotifications: NotificationItem[] = [];
let currentDirectMessages: DirectMessage[] = [];
let currentNotificationSeenAt = initialSession && browser ? readLastSeen(notificationSeenStorageKey, initialSession.pubkey) : 0;
let currentMessageSeenAt = initialSession && browser ? readLastSeen(messageSeenStorageKey, initialSession.pubkey) : 0;
let currentContactItems: ContactListItem[] = initialStoredContacts?.items ?? [];
let currentFriendsOfFriends: string[] = [];
let friendsOfFriendsKey = '';
let friendsOfFriendsToken = 0;
let currentDeletedEventIds = new Set<string>();
let hasExplicitFeedModeSelection = Boolean(initialStoredFeedMode);
let oldestFeedTimestamp: number | undefined;
let olderFeedEmptyAttempts = 0;
let liveFeedSub: { close: (reason?: string) => void } | undefined;
let liveFeedToken = 0;
let liveStatsSub: { close: (reason?: string) => void } | undefined;
let liveStatsTimer: ReturnType<typeof setTimeout> | undefined;
let liveStatsKey = '';
let visibleStatsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let liveNotificationsSub: { close: (reason?: string) => void } | undefined;
let liveMessagesSub: { close: (reason?: string) => void } | undefined;
let networkRecoveryLastRun = 0;
let networkKeepaliveTimer: ReturnType<typeof setInterval> | undefined;
let publishQueueTimer: ReturnType<typeof setTimeout> | undefined;
let liveInboxToken = 0;
let cachedOlderEvents: NostrEvent[] = [];
let cachedStatsEventsPromise: Promise<NostrEvent[]> | undefined;
const visibleStatIds = new Set<string>();
const seenLiveStatEvents = new Set<string>();
const seenLiveReactionAuthors = new Set<string>();
const seenLiveRepostAuthors = new Set<string>();
const requestedStats = new Map<string, number>();
const statsRetryMs = 60_000;
const pendingLikeToggles = new Set<string>();
const pendingRepostToggles = new Set<string>();
const pendingPublishEvents = new Map<string, { event: NostrEvent; attempts: number; nextAttemptAt: number }>();
const ownLikeEvents = new Map<string, NostrEvent>();
const ownRepostEvents = new Map<string, NostrEvent>();
const queuedThreadPrefetches: NostrEvent[] = [];
const queuedThreadPrefetchIds = new Set<string>();
const recentThreadPrefetches = new Map<string, number>();
const recentDeletionChecks = new Map<string, number>();
let activeThreadPrefetches = 0;
let defaultGlobalFeedContextPromise: Promise<void> | undefined;
let pendingGoogleOnboardingPubkey = '';

relays.subscribe((value) => {
  currentRelays = value;
  syncRelayStatus(value);
  liveStatsKey = '';
  if (visibleStatIds.size) scheduleVisibleStatsSubscription();
  restartInboxSubscriptions();
});
follows.subscribe((value) => (currentFollows = value));
mutedPubkeys.subscribe((value) => (currentMutedPubkeys = new Set(value)));
customFeedSettings.subscribe((value) => {
  currentSettings = value;
  if (browser) localStorage.setItem(customFeedStorageKey, JSON.stringify(value));
});
feedMode.subscribe((value) => (currentMode = value));
activeHashtag.subscribe((value) => (currentHashtag = value));
session.subscribe((value) => {
  currentSessionValue = value;
  currentNotificationSeenAt = value && browser ? readLastSeen(notificationSeenStorageKey, value.pubkey) : 0;
  currentMessageSeenAt = value && browser ? readLastSeen(messageSeenStorageKey, value.pubkey) : 0;
  if (value) void hydrateCachedOwnActions(value.pubkey);
  recalculateUnreadCounts();
});
notifications.subscribe((value) => {
  currentNotifications = value;
  recalculateUnreadCounts();
});
directMessages.subscribe((value) => {
  currentDirectMessages = value;
  recalculateUnreadCounts();
});
deletedEventIds.subscribe((value) => (currentDeletedEventIds = value));

export async function bootstrap() {
  if (!browser) return;
  online.set(navigator.onLine);
  addEventListener('online', handleBrowserOnline);
  addEventListener('offline', handleBrowserOffline);
  addEventListener('visibilitychange', handleVisibilityNetworkCheck);
  startNetworkKeepalive();
  restorePendingPublishes();
  void setupNativeLocalNotifications((route) => {
    void goto(appPath(route));
  });

  if (!currentSessionValue) {
    const nativeSession = await readNativePrivateKeySession();
    if (nativeSession) restoreSession(nativeSession);
  }

  const [cachedEvents, cachedProfiles, cachedDeletedIds] = await Promise.all([getCachedEvents(cachedFeedBufferLimit), getCachedProfiles(), getCachedDeletedEventIds()]);
  if (cachedDeletedIds.size) deletedEventIds.set(cachedDeletedIds);
  const cachedTopLevelEvents = recentFeedEventsForMode(
    currentMode,
    cachedEventsForMode(currentMode, topLevelFeedEvents(filterSpam(cachedEvents, currentMutedPubkeys, trustedFeedPubkeys(currentMode))), cachedFeedBufferLimit)
  );
  const visibleEvents = cachedTopLevelEvents.slice(0, Math.min(initialFeedLimit, maxFeedEvents));
  cachedOlderEvents = limitFeedBuffer(cachedTopLevelEvents.slice(visibleEvents.length), maxCachedOlderEvents);
  events.set(visibleEvents);
  oldestFeedTimestamp = timelineCursor(visibleEvents, 'oldest');
  profiles.set(mergeProfileRecords({}, cachedProfiles));

  const relayCountBeforeContext = currentRelays.length;
  const contextReady = hydrateDefaultFeedContext();
  void refreshRelayInfo();
  void refreshFeed();
  void contextReady
    .then(() => {
      void refreshRelayInfo();
      if (currentRelays.length !== relayCountBeforeContext || currentMode !== 'global' || currentHashtag) void refreshFeed();
      if (currentSessionValue) void warmSignedInSession(currentSessionValue, { refreshFeed: false });
    })
    .catch(() => {
      void refreshNotifications();
    });
}

function handleBrowserOnline() {
  online.set(true);
  void recoverNetworkState('online', { refreshFeed: true });
}

function handleBrowserOffline() {
  online.set(false);
}

function handleVisibilityNetworkCheck() {
  if (document.visibilityState === 'visible' && navigator.onLine) void recoverNetworkState('visible');
}

function startNetworkKeepalive() {
  if (networkKeepaliveTimer) return;
  networkKeepaliveTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) void recoverNetworkState('keepalive');
  }, networkKeepaliveMs);
}

async function recoverNetworkState(reason: 'online' | 'visible' | 'keepalive', options: { refreshFeed?: boolean } = {}) {
  const now = Date.now();
  if (now - networkRecoveryLastRun < networkRecoveryCooldownMs) return;
  networkRecoveryLastRun = now;
  resetRelayBackoff();
  markConnectedRelaysOnline();
  void refreshRelayInfo();
  if (options.refreshFeed || !getStoreSnapshot(events).length) void refreshFeed(currentMode).catch(() => undefined);
  else void loadNewerFeed().catch(() => undefined);
  void restartLiveFeed(currentMode, timelineCursor(feedEventsForActiveHashtag([...getStoreSnapshot(events), ...getStoreSnapshot(pendingNewerEvents)]), 'newest'));
  void restartVisibleStatsSubscription();
  if (currentSessionValue) restartInboxSubscriptions();
  drainPublishQueue();
  window.dispatchEvent(new CustomEvent('nostr-network-recovered', { detail: { reason } }));
}

export async function refreshFeed(mode = currentMode, options: { replaceVisible?: boolean; reset?: boolean; clearCache?: boolean } = {}) {
  const fetchMode = currentHashtag ? 'global' : mode;
  if (options.reset) {
    clearFeedState();
    if (options.clearCache) await clearEventCache();
  }
  const visibleEvents = feedEventsForActiveHashtag(getStoreSnapshot(events));
  const shouldReplaceVisible = options.reset || options.replaceVisible || !visibleEvents.length;
  if (!visibleEvents.length && !options.reset && !options.clearCache) void hydrateCachedFeed(fetchMode);
  loadingFeed.set(true);
  hasMoreFeed.set(true);
  olderFeedEmptyAttempts = 0;
  requestedStats.clear();

  if ((fetchMode === 'follow' && !currentFollows.length) || (fetchMode === 'custom' && !currentFollows.length && !hasCustomFeedKeywords())) {
    if (!visibleEvents.length) events.set([]);
    cachedOlderEvents = [];
    pendingNewerEvents.set([]);
    oldestFeedTimestamp = undefined;
    olderFeedEmptyAttempts = 0;
    stopLiveFeed();
    loadingFeed.set(false);
    return;
  }

  try {
    if (fetchMode === 'custom') await refreshFriendsOfFriendsAuthors();
    const newestTimestamp = options.reset ? undefined : timelineCursor([...visibleEvents, ...getStoreSnapshot(pendingNewerEvents)], 'newest');
    const nextEvents = filterMutedEvents(
      await fetchFeed(fetchMode, feedRelaysForMode(fetchMode), currentFollows, effectiveFeedSettings(fetchMode), {
        limit: initialFeedLimit,
        since: newestTimestamp ? newestTimestamp + 1 : undefined,
        hashtag: currentHashtag,
        globalAuthors: currentGlobalFeedAuthors,
        customFriendsOfFriends: currentFriendsOfFriends
      })
    );
    markConnectedRelaysOnline();
    if (nextEvents.length) {
      if (shouldReplaceVisible) {
        events.set(nextEvents);
        oldestFeedTimestamp = timelineCursor(nextEvents, 'oldest');
        pendingNewerEvents.set([]);
      } else {
        queuePendingNewer(nextEvents);
      }
      void refreshEventStats(nextEvents.map((event) => event.id));
      void hydrateMissingProfiles(nextEvents, 60);
      void pruneDeletedEvents(nextEvents);
      void primeCachedFeedBuffers(fetchMode, getStoreSnapshot(events));
    }
    void restartLiveFeed(fetchMode, timelineCursor([...visibleEvents, ...nextEvents], 'newest'));
  } finally {
    loadingFeed.set(false);
  }
}

export function clearFeedState() {
  events.set([]);
  pendingNewerEvents.set([]);
  cachedOlderEvents = [];
  oldestFeedTimestamp = undefined;
  olderFeedEmptyAttempts = 0;
  requestedStats.clear();
  stopLiveFeed();
}

async function hydrateCachedFeed(mode = currentMode) {
  if (mode === 'custom') await refreshFriendsOfFriendsAuthors();
  const cachedEvents = await getCachedFeedCandidates(mode, cachedFeedBufferLimit);
  const clean = cachedEventsForMode(mode, cachedEvents, cachedFeedBufferLimit);
  if (!clean.length) return;
  const visibleEvents = clean.slice(0, Math.min(initialFeedLimit, maxFeedEvents));
  cachedOlderEvents = limitFeedBuffer(clean.slice(visibleEvents.length), maxCachedOlderEvents);
  events.set(visibleEvents);
  oldestFeedTimestamp = timelineCursor(visibleEvents, 'oldest');
  olderFeedEmptyAttempts = 0;
  primeCachedNewerFeed(visibleEvents);
  void refreshEventStats(visibleEvents.map((event) => event.id));
  void hydrateMissingProfiles(visibleEvents, 40);
  void pruneDeletedEvents(visibleEvents);
}

function cachedEventsForMode(mode: FeedMode, items: NostrEvent[], limit = initialFeedLimit) {
  return eventsForFeedMode(mode, items).slice(0, limit);
}

export function displayEventsForFeedMode(
  mode: FeedMode,
  items: NostrEvent[],
  follows = currentFollows,
  settings = currentSettings,
  friendsOfFriends = currentFriendsOfFriends,
  enforceRecentWindow = false
) {
  const feedItems = enforceRecentWindow ? recentFeedEvents(items) : items;
  return displayFeedEvents(eventsForFeedMode(mode, feedItems, follows, settings, friendsOfFriends));
}

function eventsForFeedMode(mode: FeedMode, items: NostrEvent[], follows = currentFollows, settings = currentSettings, friendsOfFriends = currentFriendsOfFriends) {
  if (mode === 'follow') return items.filter((event) => follows.includes(event.pubkey));
  if (mode === 'custom') {
    const feedHashtags = feedKeywordHashtags(settings);
    const friendAuthors = settings.friendsOfFriends ? new Set(friendsOfFriends) : new Set<string>();
    const feedKeywords = feedKeywordTerms(settings);
    if (!follows.length && !feedHashtags.length && !feedKeywords.length) return [];
    return items.filter(
      (event) => {
        const displayEvent = feedDisplayEvent(event) ?? event;
        return (
          follows.includes(event.pubkey) ||
          (follows.length > 0 && friendAuthors.has(event.pubkey)) ||
          feedHashtags.some((tag) => eventHasHashtag(displayEvent, tag)) ||
          feedKeywords.some((keyword) => eventMatchesKeyword(displayEvent, keyword))
        );
      }
    );
  }
  if (currentHashtag) return items.filter((event) => !eventHasImgurUrl(event));
  return items.filter((event) => isGlobalFeedEvent(feedDisplayEvent(event) ?? event));
}

function displayFeedEvents(items: NostrEvent[]) {
  const byId = new Map<string, { event: NostrEvent; sortAt: number }>();
  for (const event of items) {
    const displayEvent = feedDisplayEvent(event);
    if (!displayEvent) continue;
    const existing = byId.get(displayEvent.id);
    if (!existing || event.created_at > existing.sortAt) byId.set(displayEvent.id, { event: displayEvent, sortAt: event.created_at });
  }
  return [...byId.values()].sort((a, b) => b.sortAt - a.sortAt).map((item) => item.event);
}

function feedDisplayEvent(event: NostrEvent) {
  if (event.kind === 1) return topLevelFeedEvents([event])[0];
  const reposted = parseRepostContent(event);
  return reposted ? topLevelFeedEvents([reposted])[0] : undefined;
}

async function getCachedFeedCandidates(mode: FeedMode, limit = cachedFeedBufferLimit) {
  const cachedEvents = currentHashtag ? await getCachedHashtagEvents(currentHashtag, limit) : await getCachedEvents(limit);
  const trustedPubkeys = trustedFeedPubkeys(mode);
  return recentFeedEventsForMode(
    mode,
    topLevelFeedEvents(
      filterSpam(cachedEventsForMode(mode, topLevelFeedEvents(filterSpam(cachedEvents, currentMutedPubkeys, trustedPubkeys, { blockProfanity: mode === 'global' })), limit), currentMutedPubkeys, trustedPubkeys, {
        blockProfanity: mode === 'global'
      })
    )
  );
}

async function primeCachedFeedBuffers(mode: FeedMode, visibleEvents: NostrEvent[]) {
  const cachedEvents = cachedEventsForMode(mode, await getCachedFeedCandidates(mode, cachedFeedBufferLimit), cachedFeedBufferLimit);
  if (!cachedEvents.length) return;

  const visibleIds = new Set(visibleEvents.map((event) => event.id));
  const newestTimestamp = timelineCursor(visibleEvents, 'newest');
  const oldestTimestamp = timelineCursor(visibleEvents, 'oldest');

  cachedOlderEvents = cachedEvents
    .filter((event) => !visibleIds.has(event.id) && (oldestTimestamp === undefined || event.created_at < oldestTimestamp))
    .slice(0, maxCachedOlderEvents);

  if (newestTimestamp === undefined) return;
  const cachedNewerEvents = cachedEvents
    .filter((event) => !visibleIds.has(event.id) && event.created_at > newestTimestamp)
    .slice(0, maxPendingNewerEvents);
  if (!cachedNewerEvents.length) return;
  queuePendingNewer(cachedNewerEvents);
}

function primeCachedNewerFeed(visibleEvents: NostrEvent[]) {
  const newestTimestamp = timelineCursor(visibleEvents, 'newest');
  if (newestTimestamp === undefined) return;
  const visibleIds = new Set(visibleEvents.map((event) => event.id));
  const cachedNewerEvents = cachedOlderEvents.filter((event) => !visibleIds.has(event.id) && event.created_at > newestTimestamp);
  if (!cachedNewerEvents.length) return;
  queuePendingNewer(cachedNewerEvents);
  cachedOlderEvents = cachedOlderEvents.filter((event) => !cachedNewerEvents.some((newer) => newer.id === event.id));
}

export async function loadNewerFeed() {
  const fetchMode = currentHashtag ? 'global' : currentMode;
  let loading = false;
  loadingNewerFeed.subscribe((value) => (loading = value))();
  if (loading) return;

  const newestTimestamp = timelineCursor(feedEventsForActiveHashtag([...getStoreSnapshot(events), ...getStoreSnapshot(pendingNewerEvents)]), 'newest');
  if (!newestTimestamp) return;

  loadingNewerFeed.set(true);
  try {
    if (fetchMode === 'custom') await refreshFriendsOfFriendsAuthors();
    const nextEvents = filterMutedEvents(await fetchFeed(fetchMode, feedRelaysForMode(fetchMode), currentFollows, effectiveFeedSettings(fetchMode), {
      limit: initialFeedLimit,
      since: newestTimestamp + 1,
      hashtag: currentHashtag,
      globalAuthors: currentGlobalFeedAuthors,
      customFriendsOfFriends: currentFriendsOfFriends
    }));
    markConnectedRelaysOnline();
    if (!nextEvents.length) return [];
    const existingIds = new Set(getStoreSnapshot(events).map((event) => event.id));
    const freshEvents = nextEvents.filter((event) => !existingIds.has(event.id));
    if (!freshEvents.length) return [];
    queuePendingNewer(freshEvents);
    void refreshEventStats(nextEvents.map((event) => event.id));
    void hydrateMissingProfiles(nextEvents, 60);
    return freshEvents;
  } finally {
    loadingNewerFeed.set(false);
  }
}

export function revealNewerFeed() {
  const pending = getStoreSnapshot(pendingNewerEvents);
  if (!pending.length) return;
  pendingNewerEvents.set([]);
  prependVisibleEvents(pending);
}

function stopLiveFeed() {
  liveFeedToken += 1;
  liveFeedSub?.close('restarting main feed subscription');
  liveFeedSub = undefined;
}

function stopLiveStats(reason = 'stopping visible stats subscription') {
  liveStatsSub?.close(reason);
  liveStatsSub = undefined;
  liveStatsKey = '';
}

export function watchVisibleNoteStats(id: string, visible: boolean) {
  if (!browser || !/^[0-9a-f]{64}$/i.test(id)) return;
  if (visible) {
    visibleStatIds.add(id);
    queueVisibleStatsRefresh(id);
  } else {
    visibleStatIds.delete(id);
  }
  scheduleVisibleStatsSubscription();
}

function queueVisibleStatsRefresh(id: string) {
  visibleStatIds.add(id);
  if (visibleStatsRefreshTimer) return;
  visibleStatsRefreshTimer = setTimeout(() => {
    visibleStatsRefreshTimer = undefined;
    const ids = [...visibleStatIds].slice(0, 80);
    if (ids.length) void refreshEventStats(ids);
  }, 60);
}

function scheduleVisibleStatsSubscription() {
  if (liveStatsTimer) clearTimeout(liveStatsTimer);
  liveStatsTimer = setTimeout(() => void restartVisibleStatsSubscription(), 350);
}

async function restartVisibleStatsSubscription() {
  const ids = [...visibleStatIds].sort().slice(0, 80);
  const nextKey = ids.join(',');
  if (nextKey === liveStatsKey) return;
  stopLiveStats('visible note set changed');
  if (!ids.length) return;

  liveStatsKey = nextKey;
  liveStatsSub = await subscribeEventStats(ids, currentRelays, (event) => {
    if (seenLiveStatEvents.has(event.id)) return;
    rememberLiveStatEvent(event.id);
    mergeLiveStatEvent(ids, event);
  }).catch(() => undefined);
}

function mergeLiveStatEvent(ids: string[], event: NostrEvent) {
  if (event.kind === 5) {
    applyDeletionRequest(event);
    return;
  }
  const targetIds = statTargetIdsForLocalUse(event, ids);
  if (currentSessionValue?.pubkey === event.pubkey) mergeOwnActionEvent(event, targetIds);
  if (event.kind === 7 && targetIds.every((id) => seenLiveReactionAuthors.has(`${id}:${event.pubkey}`))) return;
  if ((event.kind === 6 || event.kind === 16) && targetIds.every((id) => seenLiveRepostAuthors.has(`${id}:${event.pubkey}`))) return;

  const stats = eventStatsFromEvents(ids, [event]);
  eventStats.update((existing) => {
    const next = { ...existing };
    for (const [id, stat] of Object.entries(stats)) {
      if (!stat.replies && !stat.reposts && !stat.likes && !stat.zaps && !stat.zapSats && !stat.dislikes && !stat.emoji) continue;
      if (event.kind === 7) seenLiveReactionAuthors.add(`${id}:${event.pubkey}`);
      if (event.kind === 6 || event.kind === 16) seenLiveRepostAuthors.add(`${id}:${event.pubkey}`);
      pruneSeenActionAuthors();
      const previous = next[id] ?? emptyStats();
      next[id] = {
        replies: previous.replies + stat.replies,
        reposts: previous.reposts + stat.reposts,
        likes: previous.likes + stat.likes,
        zaps: previous.zaps + stat.zaps,
        zapSats: previous.zapSats + stat.zapSats,
        dislikes: previous.dislikes + stat.dislikes,
        emoji: previous.emoji + stat.emoji
      };
    }
    void cacheEventStats(pickStats(next, ids));
    return next;
  });
}

function applyDeletionRequest(event: NostrEvent) {
  const deletedIds = event.tags
    .filter((tag) => tag[0] === 'e' && tag[1])
    .map((tag) => tag[1])
    .filter((id) => eventAuthorForLocalUse(id) === event.pubkey);
  if (!deletedIds.length) return;
  void cacheDeletionRequest(event, deletedIds);
  applyDeletedEventIds(new Set(deletedIds), { cache: false });
}

function applyDeletedEventIds(deleted: Set<string>, options: { cache?: boolean } = {}) {
  if (!deleted.size) return;
  const shouldCache = options.cache ?? true;
  clearOwnActionsForDeletedEvents(deleted);
  deletedEventIds.update((existing) => limitStringSet(new Set([...existing, ...deleted]), maxInMemoryDeletedIds));
  events.update((existing) => existing.filter((item) => !deleted.has(item.id)));
  pendingNewerEvents.update((existing) => existing.filter((item) => !deleted.has(item.id)));
  cachedOlderEvents = cachedOlderEvents.filter((item) => !deleted.has(item.id));
  if (shouldCache) void cacheDeletedEventIds([...deleted]);
}

function clearOwnActionsForDeletedEvents(deleted: Set<string>) {
  for (const [targetId, event] of ownLikeEvents) {
    if (deleted.has(event.id)) applyLocalLikeState(targetId, event.pubkey, false, { adjustStats: true });
  }
  for (const [targetId, event] of ownRepostEvents) {
    if (deleted.has(event.id)) applyLocalRepostState(targetId, event.pubkey, false, { adjustStats: true });
  }
}

export async function pruneDeletedEvents(candidateEvents: NostrEvent[], relayHints: string[] = []) {
  if (!browser || !candidateEvents.length) return;
  const checkedAt = Date.now();
  const candidates = dedupeEvents(candidateEvents)
    .filter((event) => /^[0-9a-f]{64}$/i.test(event.id) && /^[0-9a-f]{64}$/i.test(event.pubkey))
    .filter((event) => checkedAt - (recentDeletionChecks.get(event.id) ?? 0) > deletionCheckCooldownMs);
  if (!candidates.length) return;
  candidates.forEach((event) => recentDeletionChecks.set(event.id, checkedAt));
  pruneDeletionCheckHistory(checkedAt);
  const deleted = await fetchDeletedEventIdsForEvents(candidates, currentRelays, relayHints).catch(() => new Set<string>());
  applyDeletedEventIds(deleted);
}

function pruneDeletionCheckHistory(now = Date.now()) {
  for (const [id, checkedAt] of recentDeletionChecks) {
    if (now - checkedAt > deletionCheckCooldownMs) recentDeletionChecks.delete(id);
  }
}

function eventAuthorForLocalUse(id: string) {
  return (
    getStoreSnapshot(events).find((event) => event.id === id)?.pubkey ??
    getStoreSnapshot(pendingNewerEvents).find((event) => event.id === id)?.pubkey ??
    cachedOlderEvents.find((event) => event.id === id)?.pubkey ??
    ''
  );
}

function statTargetIdsForLocalUse(event: NostrEvent, ids: string[]) {
  const wanted = new Set(ids);
  if (event.kind === 7) {
    const targetId = reactionTargetIdForLocalUse(event);
    return targetId && wanted.has(targetId) ? [targetId] : [];
  }
  if (event.kind === 6 || event.kind === 16) {
    const targetId = event.tags.find((tag) => tag[0] === 'e' && wanted.has(tag[1]))?.[1] ?? '';
    return targetId ? [targetId] : [];
  }
  return [...new Set(event.tags.filter((tag) => tag[0] === 'e' && wanted.has(tag[1])).map((tag) => tag[1]))];
}

function reactionTargetIdForLocalUse(event: NostrEvent) {
  const eTags = event.tags.filter((tag) => tag[0] === 'e' && tag[1]);
  return eTags.at(-1)?.[1] ?? '';
}

function mergeOwnActionEvent(event: NostrEvent, targetIds: string[]) {
  if (!targetIds.length) return;
  if (event.kind === 7 && (!event.content.trim() || event.content.trim() === '+')) {
    targetIds.forEach((id) => ownLikeEvents.set(id, event));
    targetIds.forEach((id) => seenLiveReactionAuthors.add(ownActionKey(id, event.pubkey)));
    likedEvents.update((existing) => limitStringSet(new Set([...existing, ...targetIds]), maxInMemoryOwnActions));
  }
  if (event.kind === 6 || event.kind === 16) {
    targetIds.forEach((id) => ownRepostEvents.set(id, event));
    targetIds.forEach((id) => seenLiveRepostAuthors.add(ownActionKey(id, event.pubkey)));
    repostedEvents.update((existing) => limitStringSet(new Set([...existing, ...targetIds]), maxInMemoryOwnActions));
  }
  pruneSeenActionAuthors();
  pruneOwnActionMemory();
}

function mergeOwnEventActions(actions: { liked: Set<string>; reposted: Set<string>; likeEvents: Map<string, NostrEvent>; repostEvents: Map<string, NostrEvent> }) {
  actions.likeEvents.forEach((event, id) => ownLikeEvents.set(id, event));
  actions.repostEvents.forEach((event, id) => ownRepostEvents.set(id, event));
  const currentPubkey = currentSessionValue?.pubkey;
  if (currentPubkey) {
    actions.liked.forEach((id) => seenLiveReactionAuthors.add(ownActionKey(id, currentPubkey)));
    actions.reposted.forEach((id) => seenLiveRepostAuthors.add(ownActionKey(id, currentPubkey)));
  }
  if (actions.liked.size) likedEvents.update((existing) => limitStringSet(new Set([...existing, ...actions.liked]), maxInMemoryOwnActions));
  if (actions.reposted.size) repostedEvents.update((existing) => limitStringSet(new Set([...existing, ...actions.reposted]), maxInMemoryOwnActions));
  pruneSeenActionAuthors();
  pruneOwnActionMemory();
}

function pruneOwnActionMemory() {
  pruneEventMap(ownLikeEvents, maxInMemoryOwnActions, getStoreSnapshot(likedEvents));
  pruneEventMap(ownRepostEvents, maxInMemoryOwnActions, getStoreSnapshot(repostedEvents));
  likedEvents.update((existing) => limitStringSet(existing, maxInMemoryOwnActions));
  repostedEvents.update((existing) => limitStringSet(existing, maxInMemoryOwnActions));
}

function pruneEventMap(map: Map<string, NostrEvent>, limit: number, priorityIds = new Set<string>()) {
  if (map.size <= limit) return;
  const priority = new Set([...priorityIds, ...visibleStatIds, ...getStoreSnapshot(events).map((event) => event.id), ...getStoreSnapshot(pendingNewerEvents).map((event) => event.id)]);
  for (const key of map.keys()) {
    if (map.size <= limit) break;
    if (!priority.has(key)) map.delete(key);
  }
}

function limitStringSet(set: Set<string>, limit: number) {
  if (set.size <= limit) return set;
  const priority = new Set([
    ...visibleStatIds,
    ...getStoreSnapshot(events).map((event) => event.id),
    ...getStoreSnapshot(pendingNewerEvents).map((event) => event.id),
    ...cachedOlderEvents.slice(0, 120).map((event) => event.id)
  ]);
  const kept = new Set<string>();
  for (const id of priority) {
    if (set.has(id)) kept.add(id);
    if (kept.size >= limit) return kept;
  }
  for (const id of [...set].reverse()) {
    kept.add(id);
    if (kept.size >= limit) break;
  }
  return kept;
}

function pruneSeenActionAuthors() {
  limitSetInPlace(seenLiveReactionAuthors, maxSeenLiveActions);
  limitSetInPlace(seenLiveRepostAuthors, maxSeenLiveActions);
}

function limitSetInPlace<T>(set: Set<T>, limit: number) {
  if (set.size <= limit) return;
  const removeCount = set.size - limit;
  let removed = 0;
  for (const item of set) {
    set.delete(item);
    removed += 1;
    if (removed >= removeCount) return;
  }
}

function rememberLiveStatEvent(id: string) {
  seenLiveStatEvents.add(id);
  limitSetInPlace(seenLiveStatEvents, maxSeenLiveEvents);
}

async function restartLiveFeed(mode = currentMode, newestTimestamp?: number) {
  const token = liveFeedToken + 1;
  stopLiveFeed();
  liveFeedToken = token;

  if (mode === 'follow' && !currentFollows.length) return;
  if (mode === 'custom' && !currentFollows.length && !hasCustomFeedKeywords()) return;
  if (mode === 'custom') await refreshFriendsOfFriendsAuthors();

  const sub = await subscribeFeed(
    mode,
    feedRelaysForMode(mode),
    currentFollows,
    effectiveFeedSettings(mode),
    { since: newestTimestamp ? newestTimestamp + 1 : Math.floor(Date.now() / 1000), hashtag: currentHashtag, globalAuthors: currentGlobalFeedAuthors, customFriendsOfFriends: currentFriendsOfFriends },
    (event) => {
      if (token !== liveFeedToken || isKnownFeedEvent(event.id) || currentMutedPubkeys.has(event.pubkey)) return;
      queuePendingNewer([event]);
      void refreshEventStats([event.id]);
      void hydrateMissingProfiles([event], 8);
    }
  ).catch(() => undefined);

  if (token !== liveFeedToken) {
    sub?.close('stale main feed subscription');
    return;
  }
  liveFeedSub = sub;
}

function isKnownFeedEvent(id: string) {
  return getStoreSnapshot(events).some((event) => event.id === id) || getStoreSnapshot(pendingNewerEvents).some((event) => event.id === id);
}

function revealCachedOlderFeed() {
  if (!cachedOlderEvents.length) return [];

  const visibleEvents = getStoreSnapshot(events);
  const nextEvents = cachedOlderFeedPage(cachedOlderEvents, visibleEvents, pageFeedLimit);
  const revealedIds = new Set(nextEvents.map((event) => event.id));
  cachedOlderEvents = cachedOlderEvents.filter((event) => !revealedIds.has(event.id));
  if (!nextEvents.length) return [];

  appendVisibleEvents(nextEvents);
  void refreshEventStats(nextEvents.map((event) => event.id));
  void hydrateMissingProfiles(nextEvents, 40);
  return nextEvents;
}

export function cachedOlderFeedPage(cached: NostrEvent[], visible: NostrEvent[], limit = pageFeedLimit) {
  const existingIds = new Set(visible.map((event) => event.id));
  const oldestVisible = timelineCursor(feedEventsForActiveHashtag(visible), 'oldest');
  return feedEventsForActiveHashtag(cached)
    .filter((event) => !existingIds.has(event.id) && (oldestVisible === undefined || event.created_at < oldestVisible))
    .slice(0, limit);
}

export async function loadMoreFeed(force = false) {
  const fetchMode = currentHashtag ? 'global' : currentMode;
  let loading = false;
  let more = true;
  loadingMoreFeed.subscribe((value) => (loading = value))();
  hasMoreFeed.subscribe((value) => (more = value))();
  if (loading || (!force && !more)) return;

  loadingMoreFeed.set(true);
  try {
    if (fetchMode === 'custom') await refreshFriendsOfFriendsAuthors();
    const revealedEvents = revealCachedOlderFeed();
    if (revealedEvents.length) {
      olderFeedEmptyAttempts = 0;
      hasMoreFeed.set(true);
      return;
    }
    const freshEvents = await fetchOlderFeedPage(fetchMode, olderFetchTarget);
    if (!freshEvents.length) {
      olderFeedEmptyAttempts += 1;
      hasMoreFeed.set(olderFeedEmptyAttempts < olderFetchEmptyAttemptLimit);
      return;
    }
    olderFeedEmptyAttempts = 0;
    hasMoreFeed.set(true);
    appendVisibleEvents(freshEvents);
    void primeCachedFeedBuffers(fetchMode, getStoreSnapshot(events));
    void refreshEventStats(freshEvents.map((event) => event.id));
    void hydrateMissingProfiles(freshEvents, 40);
    void pruneDeletedEvents(freshEvents);
  } finally {
    loadingMoreFeed.set(false);
  }
}

async function fetchOlderFeedPage(fetchMode: FeedMode, target = olderFetchTarget) {
  const collected: NostrEvent[] = [];
  let cursor = timelineCursor(feedEventsForActiveHashtag(getStoreSnapshot(events)), 'oldest') ?? oldestFeedTimestamp;

  for (let attempt = 0; attempt < olderFetchMaxAttempts && collected.length < target; attempt += 1) {
    const olderThan = cursor ? cursor - 1 : undefined;
    const nextEvents = filterMutedEvents(
      await fetchFeed(fetchMode, feedRelaysForMode(fetchMode), currentFollows, effectiveFeedSettings(fetchMode), {
        limit: olderFetchBatchLimit,
        since: olderFeedPageCutoff(cursor, fetchMode),
        until: olderThan,
        hashtag: currentHashtag,
        globalAuthors: currentGlobalFeedAuthors,
        customFriendsOfFriends: currentFriendsOfFriends
      })
    );
    markConnectedRelaysOnline();
    if (!nextEvents.length) break;

    const freshEvents = uniqueFreshItems(nextEvents, [...getStoreSnapshot(events), ...getStoreSnapshot(pendingNewerEvents), ...cachedOlderEvents, ...collected]);
    if (freshEvents.length) collected.push(...freshEvents);

    const batchOldest = timelineCursor(nextEvents, 'oldest');
    if (batchOldest === undefined || batchOldest >= (cursor ?? Number.MAX_SAFE_INTEGER)) break;
    cursor = batchOldest;
  }

  const nextOldest = timelineCursor(collected, 'oldest');
  if (nextOldest !== undefined) {
    const currentOldest = timelineCursor(feedEventsForActiveHashtag(getStoreSnapshot(events)), 'oldest') ?? oldestFeedTimestamp;
    oldestFeedTimestamp = currentOldest === undefined ? nextOldest : Math.min(currentOldest, nextOldest);
  }
  return collected.slice(0, target);
}

function queuePendingNewer(incoming: NostrEvent[]) {
  if (!incoming.length) return;
  const visibleIds = new Set(getStoreSnapshot(events).map((event) => event.id));
  pendingNewerEvents.update((existing) =>
    limitFeedBuffer(mergeFeedEvents(eventsForFeedMode(currentMode, incoming).filter((event) => !visibleIds.has(event.id)), existing), maxPendingNewerEvents)
  );
}

function prependVisibleEvents(incoming: NostrEvent[]) {
  if (!incoming.length) return;
  events.update((existing) => {
    const { visible, trimmed } = insertTimelineItems(eventsForFeedMode(currentMode, existing), eventsForFeedMode(currentMode, incoming), {
      direction: 'newer',
      limit: maxFeedEvents,
      merge: mergeFeedEvents
    });
    cacheTrimmedOlderFeedEvents(trimmed);
    oldestFeedTimestamp = timelineCursor(feedEventsForActiveHashtag(visible), 'oldest');
    return visible;
  });
}

function appendVisibleEvents(incoming: NostrEvent[]) {
  if (!incoming.length) return;
  events.update((existing) => {
    const { visible, trimmed } = insertTimelineItems(eventsForFeedMode(currentMode, existing), eventsForFeedMode(currentMode, incoming), {
      direction: 'older',
      limit: maxFeedEvents,
      merge: mergeFeedEvents
    });
    if (trimmed.length) pendingNewerEvents.update((pending) => limitFeedBuffer(mergeFeedEvents(trimmed, pending), maxPendingNewerEvents));
    oldestFeedTimestamp = timelineCursor(feedEventsForActiveHashtag(visible), 'oldest');
    return visible;
  });
}

function cacheTrimmedOlderFeedEvents(incoming: NostrEvent[]) {
  if (!incoming.length) return;
  cachedOlderEvents = limitFeedBuffer(mergeFeedEvents(incoming, cachedOlderEvents), maxCachedOlderEvents);
}

function limitFeedBuffer(items: NostrEvent[], limit: number) {
  return mergeFeedEvents([], items).slice(0, limit);
}

function recentFeedCutoff() {
  return nowSeconds() - feedRecentWindowSeconds;
}

function recentFeedCutoffForMode(mode = currentMode) {
  return nowSeconds() - (mode === 'global' && !currentHashtag ? globalFeedCachedWindowSeconds : feedRecentWindowSeconds);
}

export function olderFeedPageCutoff(cursor?: number, mode = currentMode) {
  if (mode === 'follow') return undefined;
  return cursor ? Math.max(0, cursor - olderFetchPageWindowSeconds) : recentFeedCutoffForMode(mode);
}

function recentFeedEvents(items: NostrEvent[]) {
  const cutoff = recentFeedCutoff();
  return items.filter((event) => event.created_at >= cutoff);
}

function recentFeedEventsForMode(mode: FeedMode, items: NostrEvent[]) {
  const cutoff = recentFeedCutoffForMode(mode);
  return items.filter((event) => event.created_at >= cutoff);
}

export async function refreshEventStats(ids: string[], force = false) {
  const checkedAt = Date.now();
  const nextIds = ids.filter((id) => force || checkedAt - (requestedStats.get(id) ?? 0) > statsRetryMs);
  nextIds.forEach((id) => requestedStats.set(id, checkedAt));
  pruneRequestedStats();
  if (!nextIds.length) return;
  void hydrateCachedEventStats(nextIds);
  const currentSession = currentSessionValue;
  if (currentSession) void hydrateCachedOwnActions(currentSession.pubkey, nextIds);
  const stats = await fetchEventStats(nextIds, currentRelays).catch(() => ({}));
  if (Object.keys(stats).length) {
    eventStats.update((existing) => {
      const merged = mergeStats(existing, stats);
      void cacheEventStats(pickStats(merged, Object.keys(stats)));
      return merged;
    });
  }
  if (currentSession) void refreshOwnEventActions(nextIds, currentSession);
}

async function hydrateCachedEventStats(ids: string[]) {
  if (!browser || !ids.length) return;
  const cachedSnapshots = await getCachedEventStats(ids);
  if (Object.keys(cachedSnapshots).length) eventStats.update((existing) => mergeStats(existing, cachedSnapshots));
  cachedStatsEventsPromise ??= getCachedEvents(2000).then((events) => events.filter((event) => [1, 6, 7, 16, 9735].includes(event.kind)));
  const cachedEvents = await cachedStatsEventsPromise.catch(() => []);
  if (!cachedEvents.length) return;
  const cachedStats = eventStatsFromEvents(ids, cachedEvents);
  eventStats.update((existing) => {
    const merged = mergeStats(existing, cachedStats);
    void cacheEventStats(pickStats(merged, ids));
    return merged;
  });
}

async function refreshOwnEventActions(ids: string[], currentSession: Session) {
  const ownActions = await fetchUserEventActions(ids, currentSession.pubkey, currentRelays).catch(() => ({
    liked: new Set<string>(),
    reposted: new Set<string>(),
    likeEvents: new Map<string, NostrEvent>(),
    repostEvents: new Map<string, NostrEvent>()
  }));
  if (currentSessionValue?.pubkey !== currentSession.pubkey) return;
  mergeOwnEventActions(ownActions);
  ownActions.likeEvents.forEach((event, id) => void cacheOwnAction(currentSession.pubkey, id, 'like', event));
  ownActions.repostEvents.forEach((event, id) => void cacheOwnAction(currentSession.pubkey, id, 'repost', event));
}

async function hydrateCachedOwnActions(pubkey: string, ids: string[] = []) {
  if (!browser) return;
  const actions = await getCachedOwnActions(pubkey, ids);
  if (currentSessionValue?.pubkey !== pubkey) return;
  mergeCachedOwnActions(await attachCachedOwnActionEvents(actions));
}

async function attachCachedOwnActionEvents(actions: CachedOwnAction[]) {
  const missing = actions.filter((action) => !action.event);
  if (!missing.length) return actions;

  const cachedEvents = [
    ...getStoreSnapshot(events),
    ...getStoreSnapshot(pendingNewerEvents),
    ...cachedOlderEvents,
    ...(await getCachedEvents(2000).catch(() => []))
  ];
  const actionEvent = (action: CachedOwnAction) => cachedEvents.find((event) => eventMatchesOwnAction(event, action));
  return actions.map((action) => (action.event ? action : { ...action, event: actionEvent(action) }));
}

function mergeCachedOwnActions(actions: CachedOwnAction[]) {
  if (!actions.length) return;
  const liked = new Set<string>();
  const reposted = new Set<string>();
  for (const action of actions) {
    if (action.type === 'like') {
      liked.add(action.targetId);
      if (action.event) ownLikeEvents.set(action.targetId, action.event);
      seenLiveReactionAuthors.add(ownActionKey(action.targetId, action.owner));
    }
    if (action.type === 'repost') {
      reposted.add(action.targetId);
      if (action.event) ownRepostEvents.set(action.targetId, action.event);
      seenLiveRepostAuthors.add(ownActionKey(action.targetId, action.owner));
    }
  }
  if (liked.size) likedEvents.update((existing) => limitStringSet(new Set([...existing, ...liked]), maxInMemoryOwnActions));
  if (reposted.size) repostedEvents.update((existing) => limitStringSet(new Set([...existing, ...reposted]), maxInMemoryOwnActions));
  pruneSeenActionAuthors();
  pruneOwnActionMemory();
  eventStats.update((existing) => {
    const reconciled = reconcileStatsWithOwnActions(existing, actions);
    void cacheEventStats(pickStats(reconciled, actions.map((action) => action.targetId)));
    return reconciled;
  });
}

function eventMatchesOwnAction(event: NostrEvent, action: CachedOwnAction) {
  if (event.pubkey !== action.owner) return false;
  if (action.type === 'like') return event.kind === 7 && (!event.content.trim() || event.content.trim() === '+') && reactionTargetIdForLocalUse(event) === action.targetId;
  return (event.kind === 6 || event.kind === 16) && event.tags.some((tag) => tag[0] === 'e' && tag[1] === action.targetId);
}

export function prefetchThreadPreview(event: NostrEvent) {
  if (!browser || event.kind !== 1 || !/^[0-9a-f]{64}$/i.test(event.id)) return;
  const checkedAt = Date.now();
  if (checkedAt - (recentThreadPrefetches.get(event.id) ?? 0) < threadPrefetchCooldownMs) return;
  if (queuedThreadPrefetchIds.has(event.id)) return;

  recentThreadPrefetches.set(event.id, checkedAt);
  queuedThreadPrefetchIds.add(event.id);
  queuedThreadPrefetches.push(event);
  pruneThreadPrefetchHistory(checkedAt);
  drainThreadPrefetchQueue();
}

function drainThreadPrefetchQueue() {
  while (activeThreadPrefetches < maxThreadPrefetchConcurrent && queuedThreadPrefetches.length) {
    const event = queuedThreadPrefetches.shift();
    if (!event) return;
    queuedThreadPrefetchIds.delete(event.id);
    activeThreadPrefetches += 1;
    void runThreadPreviewPrefetch(event).finally(() => {
      activeThreadPrefetches = Math.max(0, activeThreadPrefetches - 1);
      drainThreadPrefetchQueue();
    });
  }
}

async function runThreadPreviewPrefetch(event: NostrEvent) {
  refreshThreadPreviewStats(event);
  const replies = await fetchThreadReplies(event.id, currentRelays, threadPrefetchReplyLimit).catch(() => []);
  if (!replies.length) return;
  savePrefetchedThreadReplies(event.id, replies);
  refreshThreadPreviewStats(event, replies);
  void hydrateMissingProfiles(replies, 12);
  void pruneDeletedEvents(replies);
}

function refreshThreadPreviewStats(event: NostrEvent, replies: NostrEvent[] = []) {
  const statIds = [event.id, ...replies.map((reply) => reply.id)];
  const localStats = eventStatsFromEvents([event.id], replies);
  eventStats.update((existing) => mergeStats(existing, localStats));
  void refreshEventStats(statIds);
}

function pruneThreadPrefetchHistory(now = Date.now()) {
  for (const [id, checkedAt] of recentThreadPrefetches) {
    if (now - checkedAt > threadPrefetchCooldownMs) recentThreadPrefetches.delete(id);
  }
}

function mergeStats(existing: Record<string, EventStats>, incoming: Record<string, EventStats>) {
  const next = { ...existing };
  for (const [id, stat] of Object.entries(incoming)) {
    const previous = next[id] ?? emptyStats();
    next[id] = {
      replies: Math.max(previous.replies, stat.replies),
      reposts: Math.max(previous.reposts, stat.reposts),
      likes: Math.max(previous.likes, stat.likes),
      zaps: Math.max(previous.zaps, stat.zaps),
      zapSats: Math.max(previous.zapSats, stat.zapSats),
      dislikes: Math.max(previous.dislikes, stat.dislikes),
      emoji: Math.max(previous.emoji, stat.emoji)
    };
  }
  return pruneEventStats(next, Object.keys(incoming));
}

function pruneEventStats(items: Record<string, EventStats>, priorityIds: string[] = []) {
  const entries = Object.entries(items);
  if (entries.length <= maxInMemoryStats) return items;

  const priority = new Set([
    ...priorityIds,
    ...visibleStatIds,
    ...getStoreSnapshot(events).map((event) => event.id),
    ...getStoreSnapshot(pendingNewerEvents).map((event) => event.id),
    ...cachedOlderEvents.slice(0, 120).map((event) => event.id),
    ...getStoreSnapshot(likedEvents),
    ...getStoreSnapshot(repostedEvents),
    ...ownLikeEvents.keys(),
    ...ownRepostEvents.keys()
  ]);

  const kept: Record<string, EventStats> = {};
  let count = 0;
  for (const id of priority) {
    if (!items[id] || kept[id]) continue;
    kept[id] = items[id];
    count += 1;
    if (count >= maxInMemoryStats) return kept;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [id, stat] = entries[index];
    if (kept[id]) continue;
    kept[id] = stat;
    count += 1;
    if (count >= maxInMemoryStats) break;
  }
  return kept;
}

export function reconcileStatsWithOwnActions(existing: Record<string, EventStats>, actions: Pick<CachedOwnAction, 'targetId' | 'type'>[]) {
  if (!actions.length) return existing;
  const next = { ...existing };
  for (const action of actions) {
    const previous = next[action.targetId] ?? emptyStats();
    if (action.type === 'like' && previous.likes < 1) next[action.targetId] = { ...previous, likes: 1 };
    if (action.type === 'repost' && previous.reposts < 1) next[action.targetId] = { ...previous, reposts: 1 };
  }
  return pruneEventStats(next, actions.map((action) => action.targetId));
}

function pruneRequestedStats() {
  if (requestedStats.size <= maxRequestedStats) return;
  const priority = new Set([...visibleStatIds, ...getStoreSnapshot(events).map((event) => event.id), ...getStoreSnapshot(pendingNewerEvents).map((event) => event.id)]);
  const entries = [...requestedStats.entries()].sort((a, b) => {
    const priorityDelta = Number(priority.has(b[0])) - Number(priority.has(a[0]));
    if (priorityDelta) return priorityDelta;
    return b[1] - a[1];
  });
  requestedStats.clear();
  for (const [id, checkedAt] of entries.slice(0, maxRequestedStats)) requestedStats.set(id, checkedAt);
}

function pickStats(stats: Record<string, EventStats>, ids: string[]) {
  const picked: Record<string, EventStats> = {};
  for (const id of ids) {
    const stat = stats[id];
    if (stat) picked[id] = stat;
  }
  return picked;
}

function filterMutedEvents(items: NostrEvent[]) {
  return currentMutedPubkeys.size ? items.filter((event) => !currentMutedPubkeys.has(event.pubkey)) : items;
}

export function filterByHashtag(tag: string) {
  const clean = tag.trim().replace(/^#/, '').toLowerCase();
  activeHashtag.set(clean);
  cachedOlderEvents = [];
  olderFeedEmptyAttempts = 0;
  hasMoreFeed.set(true);
  void hydrateCachedHashtagFeed(clean);
  void refreshFeed('global');
}

async function hydrateCachedHashtagFeed(tag: string) {
  const cached = topLevelFeedEvents(filterSpam(await getCachedHashtagEvents(tag, cachedFeedBufferLimit), currentMutedPubkeys));
  if (!cached.length || tag !== currentHashtag) return;
  const visibleEvents = cached.slice(0, initialFeedLimit);
  cachedOlderEvents = cached.slice(initialFeedLimit);
  events.set(visibleEvents);
  oldestFeedTimestamp = timelineCursor(visibleEvents, 'oldest');
  olderFeedEmptyAttempts = 0;
  primeCachedNewerFeed(visibleEvents);
  void refreshEventStats(visibleEvents.map((event) => event.id));
  void hydrateMissingProfiles(visibleEvents, 40);
}

export function selectFeedMode(mode: FeedMode) {
  hasExplicitFeedModeSelection = true;
  if (currentSessionValue) persistStoredFeedMode(currentSessionValue.pubkey, mode);
  activeHashtag.set('');
  cachedOlderEvents = [];
  olderFeedEmptyAttempts = 0;
  hasMoreFeed.set(true);
  pendingNewerEvents.set([]);
  feedMode.set(mode);
  void hydrateCachedFeed(mode);
  void refreshFeed(mode, { replaceVisible: true });
}

export function completeOnboardingInterests(interests: string[]) {
  const currentSession = currentSessionValue;
  if (!currentSession) {
    onboardingDialogOpen.set(false);
    return;
  }

  const keywords = keywordsForInterests(interests);
  if (keywords.length) {
    customFeedSettings.update((settings) => ({
      ...settings,
      keywords: [...new Set([...settings.keywords, ...keywords])],
      interests: [...new Set([...settings.interests, ...interests.map((interest) => interest.trim().toLowerCase()).filter(Boolean)])]
    }));
    selectFeedMode('custom');
  }

  markOnboardingComplete(currentSession.pubkey);
  pendingGoogleOnboardingPubkey = '';
  onboardingDialogOpen.set(false);
}

export function dismissOnboarding() {
  if (currentSessionValue) markOnboardingComplete(currentSessionValue.pubkey);
  pendingGoogleOnboardingPubkey = '';
  onboardingDialogOpen.set(false);
}

export function goHome() {
  activeHashtag.set('');
  cachedOlderEvents = [];
  olderFeedEmptyAttempts = 0;
  hasMoreFeed.set(true);
  void hydrateCachedFeed(currentMode);
  void refreshFeed(currentMode);
}

export async function refreshRelayInfo() {
  const enriched = await fetchRelayInfoDocuments(currentRelays).catch(() => currentRelays);
  relays.set(enriched);
}

function markConnectedRelaysOnline() {
  markRelaysOnline(connectedRelayUrls());
  markRelaysOffline(temporarilyUnavailableRelayUrls());
}

export async function refreshMessages() {
  const currentSession = getStoreSnapshot(session);
  if (!currentSession) {
    directMessages.set([]);
    return;
  }

  await hydrateCachedDirectMessages(currentSession);
  loadingMessages.set(true);
  try {
    const messages = await fetchDirectMessages(currentSession, currentRelays);
    const merged = mergeDirectMessages(messages, getStoreSnapshot(directMessages), currentSession.pubkey);
    directMessages.set(merged);
    void cacheDirectMessages(currentSession.pubkey, merged);
  } finally {
    loadingMessages.set(false);
  }
}

async function hydrateCachedDirectMessages(currentSession: Session) {
  if (getStoreSnapshot(directMessages).length) return;
  const cached = await getCachedDirectMessages(currentSession.pubkey).catch(() => []);
  if (!cached.length || currentSessionValue?.pubkey !== currentSession.pubkey) return;
  directMessages.set(mergeDirectMessages(cached, [], currentSession.pubkey));
}

export async function refreshNotifications() {
  const currentSession = getStoreSnapshot(session);
  if (!currentSession) {
    notifications.set([]);
    return;
  }

  await hydrateCachedNotifications(currentSession);
  loadingNotifications.set(true);
  try {
    const nextNotifications = (await fetchNotifications(currentSession.pubkey, currentRelays, maxNotificationItems).catch(() => [])).filter((item) => !currentMutedPubkeys.has(item.actor));
    const merged = mergeNotifications(nextNotifications, getStoreSnapshot(notifications));
    notifications.set(merged);
    void cacheNotifications(currentSession.pubkey, merged);
    const pubkeys = [...new Set(merged.map((item) => item.actor))];
    await hydrateMissingProfiles(pubkeys.map((pubkey) => ({ id: pubkey, pubkey, created_at: 0, kind: 0, tags: [], content: '' })), 80);
  } finally {
    loadingNotifications.set(false);
  }
}

async function hydrateCachedNotifications(currentSession: Session) {
  if (getStoreSnapshot(notifications).length) return;
  const cached = await getCachedNotifications(currentSession.pubkey, maxNotificationItems).catch(() => []);
  if (!cached.length || currentSessionValue?.pubkey !== currentSession.pubkey) return;
  const merged = mergeNotifications(cached, []);
  notifications.set(merged);
  const pubkeys = [...new Set(merged.map((item) => item.actor))];
  void hydrateMissingProfiles(pubkeys.map((pubkey) => ({ id: pubkey, pubkey, created_at: 0, kind: 0, tags: [], content: '' })), 80);
}

export function markNotificationsSeen() {
  const currentSession = currentSessionValue;
  if (!currentSession) return;
  currentNotificationSeenAt = Math.max(nowSeconds(), newestNotificationTimestamp());
  persistLastSeen(notificationSeenStorageKey, currentSession.pubkey, currentNotificationSeenAt);
  recalculateUnreadCounts();
}

export function markMessagesSeen() {
  const currentSession = currentSessionValue;
  if (!currentSession) return;
  currentMessageSeenAt = Math.max(nowSeconds(), newestIncomingMessageTimestamp(currentSession.pubkey));
  persistLastSeen(messageSeenStorageKey, currentSession.pubkey, currentMessageSeenAt);
  recalculateUnreadCounts();
}

export async function resolveMessageRecipient(value: string) {
  const pubkey = normalizePubkey(await resolvePubkeyIdentifier(value, currentRelays).catch(() => ''));
  if (!pubkey) throw new Error('Could not resolve that npub or NIP-05 address.');
  void hydrateMissingProfiles([{ id: pubkey, pubkey, created_at: 0, kind: 0, tags: [], content: '' }], 1);
  activeMessagePeer.set(pubkey);
  return pubkey;
}

export function selectMessagePeer(pubkey: string) {
  activeMessagePeer.set(normalizePubkey(pubkey));
}

export async function sendDirectMessage(peer: string, content: string) {
  const currentSession = requireSession('Sign in before sending a message.');
  const recipient = normalizePubkey(peer);
  const clean = content.trim();
  if (!clean || !recipient) return;
  const wraps = await publishNip17DirectMessage(currentSession, recipient, clean, currentRelays);
  const message: DirectMessage = {
    id: wraps[0]?.id ?? `${currentSession.pubkey}:${recipient}:${Date.now()}`,
    protocol: 'NIP-17',
    peer: recipient,
    from: normalizePubkey(currentSession.pubkey),
    to: recipient,
    created_at: Math.floor(Date.now() / 1000),
    encrypted: wraps[0]?.content ?? '',
    content: clean
  };
  const merged = mergeDirectMessages([message], getStoreSnapshot(directMessages), currentSession.pubkey);
  directMessages.set(merged);
  void cacheDirectMessages(currentSession.pubkey, merged);
  activeMessagePeer.set(recipient);
}

export async function signIn(mode: LoginMode | 'guest', value = '', options: { rememberNativePrivateKey?: boolean } = {}) {
  const pomegranateProvider = mode === 'pomegranate' ? ((value || 'google') as PomegranateLoginProvider) : undefined;
  const next =
    mode === 'nip07'
      ? await loginWithNip07()
      : mode === 'private-key'
        ? loginWithPrivateKey(value)
        : mode === 'bunker'
          ? await loginWithBunker(value)
          : mode === 'pomegranate'
            ? await loginWithPomegranateProvider(pomegranateProvider)
            : createGuestSession();
  if (isCurrentSession(next)) return;
  await activateSession(next, {
    pomegranateProvider,
    rememberNativePrivateKey: mode === 'private-key' ? options.rememberNativePrivateKey : undefined
  });
}

export async function signInWithImportedNsec(value: string, provider: PomegranateLoginProvider = 'google', options: { replaceExisting?: boolean } = {}) {
  const next = await importNsecIntoPomegranate(value, provider, options);
  if (isCurrentSession(next)) return;
  await activateSession(next);
}

export async function signOut() {
  session.set(null);
  if (browser) localStorage.removeItem(sessionStorageKey);
  if (browser) sessionStorage.removeItem(sessionStorageKey);
  await clearNativePrivateKeySession();
  clearPomegranateAuth();
  activeHashtag.set('');
  hasExplicitFeedModeSelection = false;
  feedMode.set('global');
  customFeedSettings.set(defaultCustomFeedSettings);
  if (browser) localStorage.removeItem(customFeedStorageKey);
  currentContactItems = [];
  currentFriendsOfFriends = [];
  friendsOfFriendsKey = '';
  follows.set([]);
  cachedOlderEvents = [];
  if (browser) await goto(appPath('/'));
  await hydrateGuestFeedContext();
  void refreshFeed('global');
  notifications.set([]);
  directMessages.set([]);
  unreadNotificationCount.set(0);
  unreadMessageCount.set(0);
  activeMessagePeer.set('');
  stopInboxSubscriptions();
  mutedPubkeys.set([]);
  replyTarget.set(null);
  editTarget.set(null);
  quoteTarget.set(null);
}

export async function postNote(content: string, parent?: NostrEvent, extraTags: string[][] = []) {
  let currentSession: Session | null = null;
  session.subscribe((value) => (currentSession = value))();
  if (!currentSession) throw new Error('Sign in before posting.');
  const tags = mergePublishTags(parent ? replyTags(parent) : [], extraTags);
  const event = await signNote(currentSession, content, tags);
  rememberLiveStatEvent(event.id);
  events.update((existing) => mergeEvents([event], existing));
  void cacheEvents([event]);
  enqueuePublish(event);
  if (parent) mergeLocalReplyStats(event);
  replyTarget.set(null);
  quoteTarget.set(null);
}

function enqueuePublish(event: NostrEvent) {
  if (pendingPublishEvents.has(event.id)) return;
  pendingPublishEvents.set(event.id, { event, attempts: 0, nextAttemptAt: Date.now() });
  prunePendingPublishes();
  persistPendingPublishes();
  drainPublishQueue();
}

function hasClientPublishRuntime() {
  return typeof window !== 'undefined';
}

function hasClientStorage() {
  return typeof localStorage !== 'undefined';
}

function drainPublishQueue() {
  if (!hasClientPublishRuntime() || publishQueueTimer) return;
  publishQueueTimer = setTimeout(() => {
    publishQueueTimer = undefined;
    void publishQueuedEvents();
  }, 0);
}

async function publishQueuedEvents() {
  const now = Date.now();
  const ready = [...pendingPublishEvents.values()].filter((item) => item.nextAttemptAt <= now);
  for (const item of ready) {
    try {
      await publishSignedNostrEvent(item.event, currentRelays);
      pendingPublishEvents.delete(item.event.id);
      persistPendingPublishes();
    } catch {
      const attempts = item.attempts + 1;
      if (attempts >= publishRetryLimit) {
        pendingPublishEvents.delete(item.event.id);
        persistPendingPublishes();
        continue;
      }
      pendingPublishEvents.set(item.event.id, {
        ...item,
        attempts,
        nextAttemptAt: Date.now() + Math.min(publishRetryBaseMs * 2 ** Math.max(0, attempts - 1), publishRetryMaxMs)
      });
      persistPendingPublishes();
    }
  }

  const nextAttemptAt = Math.min(...[...pendingPublishEvents.values()].map((item) => item.nextAttemptAt));
  if (Number.isFinite(nextAttemptAt)) {
    publishQueueTimer = setTimeout(() => {
      publishQueueTimer = undefined;
      void publishQueuedEvents();
    }, Math.max(500, nextAttemptAt - Date.now()));
  }
}

function restorePendingPublishes() {
  if (!hasClientStorage()) return;
  try {
    const raw = localStorage.getItem(pendingPublishStorageKey);
    const items = raw ? (JSON.parse(raw) as Array<{ event: NostrEvent; attempts?: number; nextAttemptAt?: number }>) : [];
    for (const item of items) {
      if (!isPublishableCachedEvent(item.event)) continue;
      pendingPublishEvents.set(item.event.id, {
        event: item.event,
        attempts: Math.max(0, item.attempts ?? 0),
        nextAttemptAt: Math.min(item.nextAttemptAt ?? 0, Date.now())
      });
    }
    prunePendingPublishes();
    if (pendingPublishEvents.size) drainPublishQueue();
  } catch {
    localStorage.removeItem(pendingPublishStorageKey);
  }
}

function persistPendingPublishes() {
  if (!hasClientStorage()) return;
  const items = [...pendingPublishEvents.values()].slice(-maxPendingPublishes);
  if (!items.length) {
    localStorage.removeItem(pendingPublishStorageKey);
    return;
  }
  localStorage.setItem(pendingPublishStorageKey, JSON.stringify(items));
}

function prunePendingPublishes() {
  if (pendingPublishEvents.size <= maxPendingPublishes) return;
  const sorted = [...pendingPublishEvents.values()].sort((a, b) => a.event.created_at - b.event.created_at);
  for (const item of sorted.slice(0, pendingPublishEvents.size - maxPendingPublishes)) pendingPublishEvents.delete(item.event.id);
}

function isPublishableCachedEvent(event: NostrEvent | undefined): event is NostrEvent {
  return Boolean(event && /^[0-9a-f]{64}$/i.test(event.id) && /^[0-9a-f]{64}$/i.test(event.pubkey) && event.sig && event.kind === 1);
}

export async function editNote(content: string, target: NostrEvent, extraTags: string[][] = []) {
  const currentSession = requireSession('Sign in before editing.');
  if (target.pubkey !== currentSession.pubkey) throw new Error('You can only edit your own posts.');
  const optimisticEvent = { ...target, content, created_at: Math.floor(Date.now() / 1000) };
  editedEvents.update((existing) => ({ ...existing, [target.id]: optimisticEvent }));
  events.update((existing) => existing.map((item) => (item.id === target.id ? optimisticEvent : item)));
  pendingNewerEvents.update((existing) => existing.map((item) => (item.id === target.id ? optimisticEvent : item)));
  cachedOlderEvents = cachedOlderEvents.map((item) => (item.id === target.id ? optimisticEvent : item));
  replyTarget.set(null);
  editTarget.set(null);
  quoteTarget.set(null);
  await publishNote(currentSession, content, currentRelays, mergePublishTags(target.tags, extraTags));
  await publishDeletion(currentSession, target, currentRelays, 'Edited by author');
}

export async function deleteNote(target: NostrEvent) {
  const currentSession = requireSession('Sign in before deleting.');
  if (target.pubkey !== currentSession.pubkey) throw new Error('You can only delete your own posts.');
  const deletion = await publishDeletion(currentSession, target, currentRelays, 'Deleted by author');
  await cacheDeletionRequest(deletion, [target.id]);
  applyDeletedEventIds(new Set([target.id]), { cache: false });
  editedEvents.update((existing) => {
    const next = { ...existing };
    delete next[target.id];
    return next;
  });
  if (getStoreSnapshot(replyTarget)?.id === target.id) replyTarget.set(null);
  if (getStoreSnapshot(editTarget)?.id === target.id) editTarget.set(null);
  if (getStoreSnapshot(quoteTarget)?.id === target.id) quoteTarget.set(null);
}

export async function repostNote(target: NostrEvent) {
  const currentSession = requireSession('Sign in before reposting.');
  const pendingKey = ownActionKey(target.id, currentSession.pubkey);
  if (pendingRepostToggles.has(pendingKey)) return;
  pendingRepostToggles.add(pendingKey);

  const alreadyReposted = getStoreSnapshot(repostedEvents).has(target.id);
  if (alreadyReposted) {
    const repostEventPromise = ownRepostEvents.has(target.id) ? Promise.resolve(ownRepostEvents.get(target.id)) : findOwnRepostEvent(target.id, currentSession);
    applyLocalRepostState(target.id, currentSession.pubkey, false, { adjustStats: true });
    try {
      const repostEvent = await repostEventPromise;
      if (repostEvent) {
        await publishDeletion(currentSession, repostEvent, currentRelays, 'Unreposted by author');
        applyDeletedEventIds(new Set([repostEvent.id]));
      }
      return;
    } catch (err) {
      const repostEvent = await repostEventPromise.catch(() => undefined);
      applyLocalRepostState(target.id, currentSession.pubkey, true, { adjustStats: true, event: repostEvent });
      throw err;
    } finally {
      pendingRepostToggles.delete(pendingKey);
    }
  }

  applyLocalRepostState(target.id, currentSession.pubkey, true, { adjustStats: true });

  const existingRepostEvent = ownRepostEvents.get(target.id) ?? (await fetchOwnRepostEvent(target.id, currentSession));
  if (existingRepostEvent) {
    applyLocalRepostState(target.id, currentSession.pubkey, true, { event: existingRepostEvent });
    pendingRepostToggles.delete(pendingKey);
    return;
  }

  try {
    const event = await publishRepost(currentSession, target, currentRelays);
    applyLocalRepostState(target.id, currentSession.pubkey, true, { event });
    rememberLiveStatEvent(event.id);
    events.update((existing) => mergeEvents([event], existing));
    void cacheEvents([event]);
  } catch (err) {
    applyLocalRepostState(target.id, currentSession.pubkey, false, { adjustStats: true });
    throw err;
  } finally {
    pendingRepostToggles.delete(pendingKey);
  }
}

export async function reactToNote(target: NostrEvent, content = '+') {
  const currentSession = requireSession('Sign in before liking.');
  if (content !== '+' && content) {
    await publishReaction(currentSession, target, currentRelays, content);
    return;
  }

  const pendingKey = ownActionKey(target.id, currentSession.pubkey);
  if (pendingLikeToggles.has(pendingKey)) return;
  pendingLikeToggles.add(pendingKey);

  const alreadyLiked = getStoreSnapshot(likedEvents).has(target.id);

  if (alreadyLiked) {
    const reactionEventPromise = ownLikeEvents.has(target.id) ? Promise.resolve(ownLikeEvents.get(target.id)) : fetchOwnLikeEvent(target.id, currentSession);
    applyLocalLikeState(target.id, currentSession.pubkey, false, { adjustStats: true });
    try {
      const reactionEvent = await reactionEventPromise;
      if (reactionEvent) await publishDeletion(currentSession, reactionEvent, currentRelays, 'Unliked by author');
      return;
    } catch (err) {
      const reactionEvent = await reactionEventPromise.catch(() => undefined);
      applyLocalLikeState(target.id, currentSession.pubkey, true, { adjustStats: true, event: reactionEvent });
      throw err;
    } finally {
      pendingLikeToggles.delete(pendingKey);
    }
  }

  applyLocalLikeState(target.id, currentSession.pubkey, true, { adjustStats: true });

  const existingLikeEvent = ownLikeEvents.get(target.id) ?? (await fetchOwnLikeEvent(target.id, currentSession));
  if (existingLikeEvent) {
    applyLocalLikeState(target.id, currentSession.pubkey, true, { event: existingLikeEvent });
    pendingLikeToggles.delete(pendingKey);
    return;
  }

  try {
    const event = await publishReaction(currentSession, target, currentRelays, content);
    rememberLiveStatEvent(event.id);
    if (content === '+' || !content) applyLocalLikeState(target.id, currentSession.pubkey, true, { event });
  } catch (err) {
    applyLocalLikeState(target.id, currentSession.pubkey, false, { adjustStats: true });
    throw err;
  } finally {
    pendingLikeToggles.delete(pendingKey);
  }
}

async function fetchOwnLikeEvent(targetId: string, currentSession: Session) {
  const actions = await fetchUserEventActions([targetId], currentSession.pubkey, currentRelays).catch(() => undefined);
  return actions?.likeEvents.get(targetId);
}

async function fetchOwnRepostEvent(targetId: string, currentSession: Session) {
  const actions = await fetchUserEventActions([targetId], currentSession.pubkey, currentRelays).catch(() => undefined);
  return actions?.repostEvents.get(targetId);
}

async function findOwnRepostEvent(targetId: string, currentSession: Session) {
  return (await findLocalOwnRepostEvent(targetId, currentSession.pubkey)) ?? (await fetchOwnRepostEvent(targetId, currentSession));
}

async function findLocalOwnRepostEvent(targetId: string, pubkey: string) {
  const localEvents = [...getStoreSnapshot(events), ...getStoreSnapshot(pendingNewerEvents), ...cachedOlderEvents];
  const local = localEvents.find((event) => eventMatchesOwnRepost(event, targetId, pubkey));
  if (local) return local;
  const cachedEvents = await getCachedEvents(2000).catch(() => []);
  return cachedEvents.find((event) => eventMatchesOwnRepost(event, targetId, pubkey));
}

function eventMatchesOwnRepost(event: NostrEvent, targetId: string, pubkey: string) {
  return event.pubkey === pubkey && (event.kind === 6 || event.kind === 16) && event.tags.some((tag) => tag[0] === 'e' && tag[1] === targetId);
}

function applyLocalLikeState(targetId: string, pubkey: string, active: boolean, options: { adjustStats?: boolean; event?: NostrEvent | undefined } = {}) {
  if (active) {
    likedEvents.update((existing) => limitStringSet(new Set(existing).add(targetId), maxInMemoryOwnActions));
    seenLiveReactionAuthors.add(ownActionKey(targetId, pubkey));
    if (options.event) ownLikeEvents.set(targetId, options.event);
    pruneSeenActionAuthors();
    pruneOwnActionMemory();
    void cacheOwnAction(pubkey, targetId, 'like', options.event);
    if (options.adjustStats) adjustEventStats(targetId, { likes: 1 });
    return;
  }

  likedEvents.update((existing) => {
    const next = new Set(existing);
    next.delete(targetId);
    return next;
  });
  ownLikeEvents.delete(targetId);
  seenLiveReactionAuthors.delete(ownActionKey(targetId, pubkey));
  void removeCachedOwnAction(pubkey, targetId, 'like');
  if (options.adjustStats) adjustEventStats(targetId, { likes: -1 });
}

function applyLocalRepostState(targetId: string, pubkey: string, active: boolean, options: { adjustStats?: boolean; event?: NostrEvent | undefined } = {}) {
  if (active) {
    repostedEvents.update((existing) => limitStringSet(new Set(existing).add(targetId), maxInMemoryOwnActions));
    seenLiveRepostAuthors.add(ownActionKey(targetId, pubkey));
    if (options.event) ownRepostEvents.set(targetId, options.event);
    pruneSeenActionAuthors();
    pruneOwnActionMemory();
    void cacheOwnAction(pubkey, targetId, 'repost', options.event);
    if (options.adjustStats) adjustEventStats(targetId, { reposts: 1 });
    return;
  }

  repostedEvents.update((existing) => {
    const next = new Set(existing);
    next.delete(targetId);
    return next;
  });
  ownRepostEvents.delete(targetId);
  seenLiveRepostAuthors.delete(ownActionKey(targetId, pubkey));
  void removeCachedOwnAction(pubkey, targetId, 'repost');
  if (options.adjustStats) adjustEventStats(targetId, { reposts: -1 });
}

function ownActionKey(targetId: string, pubkey: string) {
  return `${targetId}:${pubkey}`;
}

function adjustEventStats(targetId: string, delta: Partial<Pick<EventStats, 'likes' | 'reposts'>>) {
  eventStats.update((existing) => {
    const previous = existing[targetId] ?? emptyStats();
    const nextStats = {
      ...previous,
      likes: Math.max(0, previous.likes + (delta.likes ?? 0)),
      reposts: Math.max(0, previous.reposts + (delta.reposts ?? 0))
    };
    void cacheEventStats({ [targetId]: nextStats });
    return pruneEventStats({ ...existing, [targetId]: nextStats }, [targetId]);
  });
}

export async function reportNote(target: NostrEvent, reportType = 'spam') {
  const currentSession = requireSession('Sign in before reporting.');
  await publishReport(currentSession, target, currentRelays, reportType);
}

export async function muteAccount(pubkey: string) {
  const currentSession = requireSession('Sign in before muting.');
  if (!/^[0-9a-f]{64}$/i.test(pubkey) || pubkey === currentSession.pubkey) return;
  const previous = getStoreSnapshot(mutedPubkeys);
  const next = [...new Set([...previous, pubkey])];
  mutedPubkeys.set(next);
  dropMutedEvents();
  try {
    await publishMuteList(currentSession, next, currentRelays);
  } catch (err) {
    mutedPubkeys.set(previous);
    throw err;
  }
}

export async function unmuteAccount(pubkey: string) {
  const currentSession = requireSession('Sign in before unmuting.');
  const clean = normalizePubkey(pubkey);
  if (!clean) return;
  const previous = getStoreSnapshot(mutedPubkeys);
  const next = previous.filter((item) => item !== clean);
  mutedPubkeys.set(next);
  try {
    await publishMuteList(currentSession, next, currentRelays);
  } catch (err) {
    mutedPubkeys.set(previous);
    throw err;
  }
}

export async function saveProfile(nextProfile: Profile) {
  let currentSession: Session | null = null;
  session.subscribe((value) => (currentSession = value))();
  if (!currentSession) throw new Error('Sign in before updating your profile.');
  const { profile } = await publishProfile(currentSession, nextProfile, currentRelays);
  profiles.update((existing) => mergeProfileRecords(existing, [profile]));
}

export async function saveFollowList(pubkeys: string[]) {
  const currentSession = getStoreSnapshot(session);
  if (!currentSession) throw new Error('Sign in before updating your follow list.');
  const clean = [...new Set(pubkeys.filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey)))];
  const previousContacts = new Map(currentContactItems.map((contact) => [contact.pubkey, contact]));
  currentContactItems = clean.map((pubkey) => previousContacts.get(pubkey) ?? { pubkey });
  follows.set(clean);
  persistStoredContactList(currentSession.pubkey, { pubkeys: clean, items: currentContactItems, updatedAt: nowSeconds() });
  void publishContactList(currentSession, clean, currentRelays, currentContactItems, getStoreSnapshot(profiles)).catch((err) => {
    console.warn('Could not publish follow list.', err);
  });
}

export async function saveRelayListMetadata() {
  const currentSession = requireSession('Sign in before publishing relay settings.');
  await publishRelayListMetadata(currentSession, currentRelays);
}

export async function loadPublishedRelayList() {
  const currentSession = requireSession('Sign in before loading your relay list.');
  return relayMetadataToStates(await fetchRelayListMetadata(currentSession.pubkey, currentRelays).catch(() => []));
}

export async function savePublishedRelayList(nextRelays: RelayState[], options: { addToAppRelays?: boolean } = {}) {
  const currentSession = requireSession('Sign in before publishing your relay list.');
  const cleanRelays = normalizeRelayStates(nextRelays);
  await publishRelayListMetadata(currentSession, cleanRelays, mergeRelayStates(currentRelays, cleanRelays));
  if (options.addToAppRelays) relays.set(mergeRelayStates(currentRelays, cleanRelays));
  return cleanRelays;
}

export function mergeEvents(incoming: NostrEvent[], existing: NostrEvent[]) {
  return mergeFeedEvents(incoming, existing).slice(0, maxFeedEvents);
}

function mergeFeedEvents(incoming: NostrEvent[], existing: NostrEvent[]) {
  const byId = new Map<string, NostrEvent>();
  [...existing, ...incoming].forEach((event) => byId.set(event.id, event));
  const merged = filterSpam(
    [...byId.values()].filter((event) => !currentDeletedEventIds.has(event.id)),
    currentMutedPubkeys,
    trustedFeedPubkeys(currentMode),
    { blockProfanity: currentMode === 'global' }
  ).sort((a, b) => b.created_at - a.created_at);
  const globalClean = currentMode === 'global' ? merged.filter((event) => currentGlobalFeedAuthors.includes(event.pubkey) || !eventHasImgurUrl(event)) : merged;
  const limited = currentMode === 'global' ? applyGlobalFeedLimits(globalClean) : globalClean;
  return limited;
}

function normalizePubkey(value: string) {
  const clean = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(clean) ? clean : '';
}

function feedEventsForActiveHashtag(items: NostrEvent[]) {
  if (!currentHashtag) return items;
  return items.filter((event) => eventHasHashtag(event, currentHashtag));
}

function eventHasHashtag(event: NostrEvent, tag: string) {
  const normalized = tag.trim().replace(/^#/, '').toLowerCase();
  if (!normalized) return true;
  if (event.tags.some((item) => item[0] === 't' && item[1]?.replace(/^#/, '').toLowerCase() === normalized)) return true;
  return new RegExp(`(^|\\s)#${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(event.content);
}

function isGlobalFeedEvent(event: NostrEvent) {
  if (currentGlobalFeedAuthors.includes(event.pubkey)) return true;
  return globalFeedHashtags.some((tag) => eventHasHashtag(event, tag)) && !eventHasImgurUrl(event);
}

function trustedFeedPubkeys(mode: FeedMode) {
  return mode === 'global' && !currentHashtag ? new Set(currentGlobalFeedAuthors) : new Set<string>();
}

function applyGlobalFeedLimits(items: NostrEvent[]) {
  const trusted = items.filter((event) => currentGlobalFeedAuthors.includes(event.pubkey));
  const limited = limitCryptoTopicDensity(
    limitConsecutiveAuthors(
      items.filter((event) => !currentGlobalFeedAuthors.includes(event.pubkey)),
      2
    ),
    10
  );
  if (!trusted.length) return limited;
  return [...trusted, ...limited].sort((a, b) => b.created_at - a.created_at);
}

function feedKeywordHashtags(settings: CustomFeedSettings) {
  return [
    ...new Set(
      settings.keywords
        .map((keyword) => keyword.trim().replace(/^#/, '').toLowerCase())
        .filter((keyword) => /^[a-z0-9_]{2,64}$/.test(keyword))
    )
  ];
}

function feedKeywordTerms(settings: CustomFeedSettings) {
  return [
    ...new Set(
      settings.keywords
        .filter((keyword) => !keyword.trim().startsWith('#'))
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => /^[a-z0-9][a-z0-9 _-]{1,63}$/.test(keyword))
    )
  ];
}

function hasCustomFeedKeywords(settings = currentSettings) {
  return Boolean(feedKeywordHashtags(settings).length || feedKeywordTerms(settings).length);
}

function eventMatchesKeyword(event: NostrEvent, keyword: string) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(event.content);
}

async function refreshFriendsOfFriendsAuthors() {
  if (!currentSettings.friendsOfFriends || !currentFollows.length) {
    currentFriendsOfFriends = [];
    friendsOfFriendsKey = '';
    return;
  }

  const relayUrls = activeRelayUrls(currentRelays, 'read');
  const nextKey = `${currentFollows.join(',')}|${relayUrls.join(',')}`;
  if (nextKey === friendsOfFriendsKey) return;

  const token = ++friendsOfFriendsToken;
  friendsOfFriendsKey = nextKey;
  const next = await fetchFriendsOfFriends(currentFollows, relayUrls).catch(() => []);
  if (token !== friendsOfFriendsToken) return;
  currentFriendsOfFriends = next;
}

async function hydrateMissingProfiles(nextEvents: NostrEvent[], limit = 40) {
  const existingProfiles = getStoreSnapshot(profiles);
  const pubkeys = [...new Set(nextEvents.flatMap((event) => [event.pubkey, ...event.tags.filter((tag) => tag[0] === 'p' && tag[1]).map((tag) => tag[1])]))]
    .map(normalizePubkey)
    .filter(Boolean)
    .filter((pubkey) => !existingProfiles[pubkey])
    .slice(0, limit);
  if (!pubkeys.length) return;

  const foundProfiles = await fetchProfiles(pubkeys, currentRelays).catch(() => []);
  if (!foundProfiles.length) return;
  profiles.update((existing) => mergeProfileRecords(existing, foundProfiles));
}

export function startReply(event: NostrEvent) {
  let currentSession: Session | null = null;
  session.subscribe((value) => (currentSession = value))();
  if (!currentSession) {
    loginDialogOpen.set(true);
    return;
  }
  replyTarget.set(event);
  editTarget.set(null);
  quoteTarget.set(null);
  composerOpen.set(true);
}

export function startEdit(event: NostrEvent) {
  const currentSession = getStoreSnapshot(session);
  if (!currentSession) {
    loginDialogOpen.set(true);
    return;
  }
  if (event.pubkey !== currentSession.pubkey) return;
  replyTarget.set(null);
  editTarget.set(event);
  quoteTarget.set(null);
  composerOpen.set(true);
}

export function startCompose() {
  let currentSession: Session | null = null;
  session.subscribe((value) => (currentSession = value))();
  if (!currentSession) {
    loginDialogOpen.set(true);
    return;
  }
  replyTarget.set(null);
  editTarget.set(null);
  quoteTarget.set(null);
  activeHashtag.set('');
  if (browser && (window.location.pathname !== appPath('/') || window.location.hash)) void goto(appPath('/'));
  composerOpen.set(true);
}

export function startQuote(event: NostrEvent) {
  const currentSession = getStoreSnapshot(session);
  if (!currentSession) {
    loginDialogOpen.set(true);
    return;
  }
  replyTarget.set(null);
  editTarget.set(null);
  quoteTarget.set(event);
  composerOpen.set(true);
}

function hydrateSession() {
  const saved = readStoredSession();
  if (saved) restoreSession(saved);
}

async function activateSession(
  next: Session,
  options: {
    pomegranateProvider?: PomegranateLoginProvider;
    rememberNativePrivateKey?: boolean;
  } = {}
) {
  session.set(next);
  pendingGoogleOnboardingPubkey = shouldOfferGoogleOnboarding(next, options.pomegranateProvider) ? next.pubkey : '';
  const previousFeedMode = currentMode;
  persistSession(next);
  if (next.mode === 'private-key') {
    if (options.rememberNativePrivateKey) await persistNativePrivateKeySession(next);
    else await clearNativePrivateKeySession();
  }
  restoreStoredContactListForSession(next);
  restoreStoredFeedModeForSession(next);
  activeHashtag.set('');
  currentNotificationSeenAt = browser ? readLastSeen(notificationSeenStorageKey, next.pubkey) : 0;
  currentMessageSeenAt = browser ? readLastSeen(messageSeenStorageKey, next.pubkey) : 0;
  clearFeedState();
  hasMoreFeed.set(true);
  directMessages.set([]);
  notifications.set([]);
  loadingFeed.set(true);
  if (!hasExplicitFeedModeSelection && previousFeedMode === 'global') feedMode.set('global');
  await finishSignedInBootstrap(next);
}

function restoreSession(next: Session) {
  session.set(next);
  restoreStoredContactListForSession(next);
  restoreStoredFeedModeForSession(next);
  currentNotificationSeenAt = browser ? readLastSeen(notificationSeenStorageKey, next.pubkey) : 0;
  currentMessageSeenAt = browser ? readLastSeen(messageSeenStorageKey, next.pubkey) : 0;
}

function persistSession(next: Session) {
  if (!browser) return;
  sessionStorage.removeItem(sessionStorageKey);
  if (next.mode === 'nip07') {
    localStorage.setItem(
      sessionStorageKey,
      JSON.stringify({ pubkey: next.pubkey, mode: next.mode } satisfies Session)
    );
    return;
  }
  if (next.mode === 'pomegranate' && isStoredRemoteSignerSession(next)) {
    localStorage.removeItem(sessionStorageKey);
    sessionStorage.setItem(sessionStorageKey, JSON.stringify(next));
    return;
  }
  if (next.mode === 'bunker' && isStoredRemoteSignerSession(next)) {
    localStorage.setItem(sessionStorageKey, JSON.stringify(next));
    return;
  }
  localStorage.removeItem(sessionStorageKey);
}

function readStoredSession() {
  const raw = sessionStorage.getItem(sessionStorageKey) ?? localStorage.getItem(sessionStorageKey);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Session;
    if (!saved?.pubkey || !saved?.mode || !isHexKey(saved.pubkey)) return clearStoredSession();
    if (saved.mode === 'nip07') return { pubkey: saved.pubkey, mode: saved.mode };
    if (saved.mode === 'private-key') return clearStoredSession();
    if (isStoredRemoteSignerSession(saved)) return saved;
    return clearStoredSession();
  } catch {
    return clearStoredSession();
  }
}

function isStoredRemoteSignerSession(value: Session) {
  return (
    (value.mode === 'bunker' || value.mode === 'pomegranate') &&
    isHexKey(value.pubkey) &&
    isHexKey(value.bunkerClientSecret) &&
    isHexKey(value.bunkerRemotePubkey) &&
    Array.isArray(value.bunkerRelays) &&
    value.bunkerRelays.some((relay) => /^wss?:\/\//i.test(relay)) &&
    (value.bunkerSecret == null || typeof value.bunkerSecret === 'string')
  );
}

function isHexKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function clearStoredSession() {
  localStorage.removeItem(sessionStorageKey);
  sessionStorage.removeItem(sessionStorageKey);
  return null;
}

function readStoredContactList(pubkey: string) {
  if (!browser || !pubkey) return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(contactListStorageKey) ?? '{}') as Record<string, unknown>;
    const saved = stored[pubkey] as Partial<{ pubkeys: unknown; items: unknown; updatedAt: unknown }> | undefined;
    if (!saved) return undefined;
    const pubkeys = Array.isArray(saved.pubkeys) ? [...new Set(saved.pubkeys.filter(isHexKey))] : [];
    const contactItems = (Array.isArray(saved.items) ? saved.items : []).map(readStoredContactItem).filter((item): item is ContactListItem => Boolean(item));
    const itemByPubkey = new Map(contactItems.filter((item) => pubkeys.includes(item.pubkey)).map((item) => [item.pubkey, item]));
    const items = pubkeys.map((key) => itemByPubkey.get(key) ?? { pubkey: key });
    const updatedAt = typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt) ? saved.updatedAt : 0;
    return { pubkeys, items, updatedAt };
  } catch {
    localStorage.removeItem(contactListStorageKey);
    return undefined;
  }
}

function persistStoredContactList(pubkey: string, contacts: { pubkeys: string[]; items: ContactListItem[]; updatedAt?: number }) {
  if (!browser || !pubkey) return;
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem(contactListStorageKey) ?? '{}') as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const pubkeys = [...new Set(contacts.pubkeys.filter(isHexKey))];
  const itemByPubkey = new Map(
    contacts.items
      .filter((item) => pubkeys.includes(item.pubkey))
      .map((item) => [item.pubkey, { pubkey: item.pubkey, relay: item.relay, petname: item.petname } satisfies ContactListItem])
  );
  stored[pubkey] = {
    pubkeys,
    items: pubkeys.map((key) => itemByPubkey.get(key) ?? { pubkey: key }),
    updatedAt: contacts.updatedAt ?? nowSeconds()
  };
  localStorage.setItem(contactListStorageKey, JSON.stringify(stored));
}

function readStoredContactItem(value: unknown): ContactListItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<ContactListItem>;
  if (!isHexKey(item.pubkey)) return undefined;
  return {
    pubkey: item.pubkey,
    relay: typeof item.relay === 'string' && /^wss?:\/\//i.test(item.relay) ? item.relay : undefined,
    petname: typeof item.petname === 'string' ? item.petname : undefined
  } satisfies ContactListItem;
}

function restoreStoredContactListForSession(next: Session) {
  const saved = readStoredContactList(next.pubkey);
  currentContactItems = saved?.items ?? [];
  follows.set(saved?.pubkeys ?? []);
}

function readStoredFeedMode(pubkey: string): FeedMode | undefined {
  if (!browser || !pubkey) return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(feedModeStorageKey) ?? '{}') as Record<string, unknown>;
    return isFeedMode(stored[pubkey]) ? stored[pubkey] : undefined;
  } catch {
    localStorage.removeItem(feedModeStorageKey);
    return undefined;
  }
}

function persistStoredFeedMode(pubkey: string, mode: FeedMode) {
  if (!browser || !pubkey) return;
  let stored: Record<string, FeedMode> = {};
  try {
    stored = JSON.parse(localStorage.getItem(feedModeStorageKey) ?? '{}') as Record<string, FeedMode>;
  } catch {
    stored = {};
  }
  stored[pubkey] = mode;
  localStorage.setItem(feedModeStorageKey, JSON.stringify(stored));
}

function restoreStoredFeedModeForSession(next: Session) {
  const stored = readStoredFeedMode(next.pubkey);
  if (!stored) return;
  hasExplicitFeedModeSelection = true;
  if (stored !== currentMode) feedMode.set(stored);
}

function shouldOfferGoogleOnboarding(next: Session, provider?: PomegranateLoginProvider) {
  return browser && next.mode === 'pomegranate' && provider === 'google' && !readOnboardingComplete(next.pubkey);
}

function readOnboardingComplete(pubkey: string) {
  if (!browser || !pubkey) return false;
  try {
    const stored = JSON.parse(localStorage.getItem(onboardingStorageKey) ?? '{}') as Record<string, unknown>;
    return stored[pubkey] === true;
  } catch {
    localStorage.removeItem(onboardingStorageKey);
    return false;
  }
}

function markOnboardingComplete(pubkey: string) {
  if (!browser || !pubkey) return;
  let stored: Record<string, boolean> = {};
  try {
    stored = JSON.parse(localStorage.getItem(onboardingStorageKey) ?? '{}') as Record<string, boolean>;
  } catch {
    stored = {};
  }
  stored[pubkey] = true;
  localStorage.setItem(onboardingStorageKey, JSON.stringify(stored));
}

function isFeedMode(value: unknown): value is FeedMode {
  return value === 'follow' || value === 'global' || value === 'custom';
}

function readLastSeen(storageKey: string, pubkey: string) {
  if (!browser || !pubkey) return 0;
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, number>;
    const value = stored[pubkey] ?? 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    localStorage.removeItem(storageKey);
    return 0;
  }
}

function persistLastSeen(storageKey: string, pubkey: string, value: number) {
  if (!browser || !pubkey) return;
  let stored: Record<string, number> = {};
  try {
    stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, number>;
  } catch {
    stored = {};
  }
  stored[pubkey] = value;
  localStorage.setItem(storageKey, JSON.stringify(stored));
}

function recalculateUnreadCounts() {
  const currentSession = currentSessionValue;
  if (!currentSession) {
    unreadNotificationCount.set(0);
    unreadMessageCount.set(0);
    return;
  }
  unreadNotificationCount.set(currentNotifications.filter((item) => item.event.created_at > currentNotificationSeenAt).length);
  unreadMessageCount.set(
    currentDirectMessages.filter((message) => message.from !== currentSession.pubkey && message.created_at > currentMessageSeenAt).length
  );
}

function newestNotificationTimestamp() {
  return currentNotifications.reduce((newest, item) => Math.max(newest, item.event.created_at), 0);
}

function newestIncomingMessageTimestamp(pubkey: string) {
  return currentDirectMessages.reduce((newest, message) => (message.from !== pubkey ? Math.max(newest, message.created_at) : newest), 0);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function readStoredCustomFeedSettings() {
  const raw = localStorage.getItem(customFeedStorageKey);
  if (!raw) return defaultCustomFeedSettings;
  try {
    const saved = JSON.parse(raw) as Partial<CustomFeedSettings>;
    return {
      ...defaultCustomFeedSettings,
      ...saved,
      friendsOfFriends: typeof saved.friendsOfFriends === 'boolean' ? saved.friendsOfFriends : defaultCustomFeedSettings.friendsOfFriends,
      keywords: [
        ...new Set([
          ...(Array.isArray(saved.keywords) ? saved.keywords.filter((keyword): keyword is string => typeof keyword === 'string') : []),
          ...keywordsForInterests(Array.isArray(saved.interests) ? saved.interests.filter((interest): interest is string => typeof interest === 'string') : [])
        ])
      ],
      interests: []
    };
  } catch {
    localStorage.removeItem(customFeedStorageKey);
    return defaultCustomFeedSettings;
  }
}

async function hydrateDefaultFeedContext() {
  const globalContextReady = hydrateDefaultGlobalFeedContext();
  let currentSession: Session | null = null;
  session.subscribe((value) => (currentSession = value))();
  if (currentSession) {
    await globalContextReady;
    await hydrateSignedInFeedContext(currentSession);
    selectPreferredSignedInFeed(false);
  } else {
    await globalContextReady;
    await hydrateGuestFeedContext();
  }
}

async function finishSignedInBootstrap(next: Session) {
  try {
    await hydrateSignedInFeedContext(next).catch(() => undefined);
    if (!isCurrentSession(next)) return;
    selectPreferredSignedInFeed(true);
    await refreshSignedInFeedWithFallback();
    void warmSignedInSession(next, { refreshFeed: false });
    restartInboxSubscriptions();
    if (pendingGoogleOnboardingPubkey === next.pubkey && shouldOfferGoogleOnboarding(next, 'google')) onboardingDialogOpen.set(true);
  } finally {
    if (isCurrentSession(next)) loadingFeed.set(false);
  }
}

async function refreshSignedInFeedWithFallback() {
  await refreshFeed(currentMode).catch(() => undefined);
  if (getStoreSnapshot(events).length || currentMode === 'global') return;
  activeHashtag.set('');
  cachedOlderEvents = [];
  olderFeedEmptyAttempts = 0;
  hasMoreFeed.set(true);
  feedMode.set('global');
  await refreshFeed('global').catch(() => undefined);
}

async function warmSignedInSession(currentSession: Session, options: { refreshFeed?: boolean } = {}) {
  if (!isCurrentSession(currentSession)) return;
  await Promise.all([
    hydrateOwnProfileAndPosts(currentSession),
    prefetchFollowFeed(currentSession),
    refreshNotifications(),
    refreshSignedInDirectMessages(currentSession),
    options.refreshFeed ? refreshFeed(currentMode) : Promise.resolve()
  ]);
}

async function hydrateOwnProfileAndPosts(currentSession: Session) {
  await hydrateCachedOwnProfilePosts(currentSession);
  if (!isCurrentSession(currentSession)) return;
  const [ownProfile, ownEvents] = await Promise.all([
    fetchProfiles([currentSession.pubkey], currentRelays).catch(() => []),
    fetchProfileEvents(currentSession.pubkey, currentRelays, initialFeedLimit).catch(() => [])
  ]);
  if (!isCurrentSession(currentSession)) return;
  if (ownProfile.length) profiles.update((existing) => mergeProfileRecords(existing, ownProfile));
  if (ownEvents.length) {
    events.update((existing) => mergeEvents(ownEvents, existing));
    void refreshEventStats(ownEvents.map((event) => event.id));
    void pruneDeletedEvents(ownEvents);
  }
}

async function hydrateCachedOwnProfilePosts(currentSession: Session) {
  const cached = await getCachedProfileEvents(currentSession.pubkey, initialFeedLimit).catch(() => []);
  if (!cached.length || !isCurrentSession(currentSession)) return;
  events.update((existing) => mergeEvents(cached, existing));
}

async function refreshSignedInDirectMessages(currentSession: Session) {
  await hydrateCachedDirectMessages(currentSession);
  if (currentSession.mode !== 'nip07' && isCurrentSession(currentSession)) await refreshMessages().catch(() => undefined);
}

async function prefetchFollowFeed(currentSession: Session) {
  if (!currentFollows.length || currentMode === 'follow') return;
  const followEvents = filterMutedEvents(
    await fetchFeed('follow', currentRelays, currentFollows, effectiveFeedSettings('follow'), { limit: initialFeedLimit }).catch(() => [])
  );
  if (!followEvents.length || !isCurrentSession(currentSession)) return;
  events.update((existing) => mergeEvents(followEvents, existing));
  void refreshEventStats(followEvents.map((event) => event.id));
  void hydrateMissingProfiles(followEvents, 40);
  void pruneDeletedEvents(followEvents);
}

async function hydrateSignedInFeedContext(currentSession: Session) {
  restoreStoredContactListForSession(currentSession);
  const relayList = await fetchRelayListMetadata(currentSession.pubkey, currentRelays).catch(() => []);
  if (!relayList.length && shouldPublishDefaultProfileRelays(currentSession)) void publishDefaultProfileRelays(currentSession);
  mergeRelayHints(relayList.map((relay) => relay.url), 90);
  const [contacts, muted] = await Promise.all([
    fetchContactListDetails(currentSession.pubkey, currentRelays).catch(emptyContactListDetails),
    fetchMuteList(currentSession.pubkey, currentRelays).catch(() => [])
  ]);
  const hasRelayContactList = contacts.updatedAt !== undefined;
  if (hasRelayContactList) {
    currentContactItems = contacts.items;
    follows.set(contacts.pubkeys);
    persistStoredContactList(currentSession.pubkey, contacts);
  }
  mergeRelayHints(contacts.relayHints, 74);
  mutedPubkeys.set(muted);
  dropMutedEvents();
}

function shouldPublishDefaultProfileRelays(currentSession: Session) {
  return pendingGoogleOnboardingPubkey === currentSession.pubkey && shouldOfferGoogleOnboarding(currentSession, 'google');
}

async function publishDefaultProfileRelays(currentSession: Session) {
  const cleanRelays = normalizeRelayStates(defaultProfileRelays);
  await publishRelayListMetadata(currentSession, cleanRelays, mergeRelayStates(currentRelays, cleanRelays)).catch((err) => {
    console.warn('Could not publish default profile relays.', err);
  });
}

function relayMetadataToStates(items: Array<{ url: string; marker?: string }>) {
  const byUrl = new Map<string, RelayState>();
  for (const item of items) {
    const url = normalizeRelayUrl(item.url);
    if (!url) continue;
    const existing = byUrl.get(url) ?? { url, enabled: true, read: false, write: false, score: 75 };
    if (item.marker === 'read') existing.read = true;
    else if (item.marker === 'write') existing.write = true;
    else {
      existing.read = true;
      existing.write = true;
    }
    byUrl.set(url, existing);
  }
  return normalizeRelayStates([...byUrl.values()]);
}

function normalizeRelayStates(items: RelayState[]) {
  const byUrl = new Map<string, RelayState>();
  for (const item of items) {
    const url = normalizeRelayUrl(item.url);
    if (!url) continue;
    const existing = byUrl.get(url);
    byUrl.set(url, {
      ...item,
      ...(existing ?? {}),
      url,
      enabled: item.enabled !== false,
      read: Boolean(item.read || existing?.read),
      write: Boolean(item.write || existing?.write),
      score: Number.isFinite(item.score) ? item.score : existing?.score ?? 75
    });
  }
  return [...byUrl.values()].filter((relay) => relay.read || relay.write || relay.enabled);
}

function mergeRelayStates(base: RelayState[], incoming: RelayState[]) {
  const byUrl = new Map<string, RelayState>();
  for (const relay of [...base, ...incoming]) {
    const url = normalizeRelayUrl(relay.url);
    if (!url) continue;
    const previous = byUrl.get(url);
    byUrl.set(url, {
      ...relay,
      ...(previous ?? {}),
      url,
      enabled: relay.enabled !== false || previous?.enabled === true,
      read: Boolean(relay.read || previous?.read),
      write: Boolean(relay.write || previous?.write),
      score: Math.max(relay.score ?? 0, previous?.score ?? 0, 50)
    });
  }
  return [...byUrl.values()];
}

function emptyContactListDetails(): ContactListDetails {
  return { pubkeys: [], relayHints: [], items: [] };
}

function selectPreferredSignedInFeed(allowInitialDefault = false) {
  activeHashtag.set('');
  cachedOlderEvents = [];
  if (hasExplicitFeedModeSelection) return;
  if (allowInitialDefault && !getStoreSnapshot(events).length) feedMode.set(currentFollows.length ? 'follow' : 'global');
}

function isCurrentSession(next: Session) {
  return currentSessionValue?.pubkey === next.pubkey && currentSessionValue.mode === next.mode;
}

function restartInboxSubscriptions() {
  const currentSession = currentSessionValue;
  stopInboxSubscriptions();
  if (!currentSession) return;

  const token = ++liveInboxToken;
  void subscribeNotifications(currentSession.pubkey, currentRelays, (items) => {
    if (token !== liveInboxToken || currentSessionValue?.pubkey !== currentSession.pubkey) return;
    const existingNotifications = getStoreSnapshot(notifications);
    const existingNotificationIds = new Set(existingNotifications.map((item) => item.id));
    notifyNativeForLiveNotifications(items.filter((item) => !existingNotificationIds.has(item.id) && item.event.created_at > currentNotificationSeenAt));
    notifications.update((existing) => {
      const merged = mergeNotifications(items, existing);
      void cacheNotifications(currentSession.pubkey, merged);
      return merged;
    });
    void hydrateMissingProfiles(items.map((item) => item.event), 20);
  }).then((sub) => {
    if (token === liveInboxToken && currentSessionValue?.pubkey === currentSession.pubkey) liveNotificationsSub = sub;
    else sub?.close();
  });

  void subscribeDirectMessages(currentSession, currentRelays, (message) => {
    if (token !== liveInboxToken || currentSessionValue?.pubkey !== currentSession.pubkey) return;
    const merged = mergeDirectMessages([message], getStoreSnapshot(directMessages), currentSession.pubkey);
    directMessages.set(merged);
    void cacheDirectMessages(currentSession.pubkey, merged);
  }).then((sub) => {
    if (token === liveInboxToken && currentSessionValue?.pubkey === currentSession.pubkey) liveMessagesSub = sub;
    else sub?.close();
  });
}

function stopInboxSubscriptions() {
  liveInboxToken += 1;
  liveNotificationsSub?.close();
  liveMessagesSub?.close();
  liveNotificationsSub = undefined;
  liveMessagesSub = undefined;
}

function mergeNotifications(next: NotificationItem[], existing: NotificationItem[]) {
  const byId = new Map<string, NotificationItem>();
  for (const item of [...next, ...existing]) {
    if (!isActivityNotification(item)) continue;
    if (currentMutedPubkeys.has(item.actor)) continue;
    const existingItem = byId.get(item.id);
    if (!existingItem || item.event.created_at >= existingItem.event.created_at) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.event.created_at - a.event.created_at).slice(0, maxNotificationItems);
}

function isActivityNotification(item: NotificationItem) {
  return item.type === 'reply' || item.type === 'mention' || item.type === 'like' || item.type === 'repost';
}

function notifyNativeForLiveNotifications(items: NotificationItem[]) {
  if (!browser || !items.length) return;
  const currentProfiles = getStoreSnapshot(profiles);
  for (const item of items.slice(0, 4)) {
    void showNativeNotificationForItem(item, currentProfiles[item.actor]);
  }
}

async function hydrateGuestFeedContext() {
  await hydrateDefaultGlobalFeedContext();
  currentContactItems = [];
  follows.set([]);
  mutedPubkeys.set([]);
}

function hydrateDefaultGlobalFeedContext() {
  defaultGlobalFeedContextPromise ??= resolveDefaultGlobalFeedContext();
  return defaultGlobalFeedContextPromise;
}

async function resolveDefaultGlobalFeedContext() {
  const [profile, curatorContacts] = await Promise.all([
    resolveNip05Profile(defaultGuestNip05).catch(() => null),
    fetchContactListDetails(globalFeedCuratorPubkey, currentRelays).catch(emptyContactListDetails)
  ]);
  mergeRelayHints(curatorContacts.relayHints, 74);
  if (profile) {
    mergeRelayHints(profile.relayHints, 96);
    const relayList = await fetchRelayListMetadata(profile.pubkey, currentRelays).catch(() => []);
    mergeRelayHints(relayList.map((relay) => relay.url), 90);
    const contacts = await fetchContactListDetails(profile.pubkey, currentRelays).catch(() => ({ pubkeys: [], relayHints: [], items: [] }));
    mergeRelayHints(contacts.relayHints, 74);
    currentGlobalFeedAuthors = mergeGlobalFeedAuthors(defaultGlobalFeedAuthors, contacts.pubkeys, curatorContacts.pubkeys);
  } else {
    currentGlobalFeedAuthors = mergeGlobalFeedAuthors(defaultGlobalFeedAuthors, curatorContacts.pubkeys);
  }
}

function mergeGlobalFeedAuthors(...groups: string[][]) {
  return [...new Set(groups.flat().filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey)))];
}

function dropMutedEvents() {
  if (!currentMutedPubkeys.size) return;
  events.update((existing) => filterMutedEvents(existing));
  pendingNewerEvents.update((existing) => filterMutedEvents(existing));
  cachedOlderEvents = filterMutedEvents(cachedOlderEvents);
  notifications.update((existing) => existing.filter((item) => !currentMutedPubkeys.has(item.event.pubkey)));
}

function mergeLocalReplyStats(reply: NostrEvent) {
  const targetIds = [...new Set(reply.tags.flatMap((tag) => (tag[0] === 'e' && tag[1] ? [tag[1]] : [])))];
  if (!targetIds.length) return;

  const stats = eventStatsFromEvents(targetIds, [reply]);
  eventStats.update((existing) => {
    const next = { ...existing };
    for (const id of targetIds) {
      const stat = stats[id];
      if (!stat?.replies) continue;
      const previous = next[id] ?? emptyStats();
      next[id] = {
        ...previous,
        replies: previous.replies + stat.replies
      };
    }
    return pruneEventStats(next, targetIds);
  });
}

function replyTags(parent: NostrEvent) {
  const parentRoot = parent.tags.find((tag) => tag[0] === 'e' && tag[3] === 'root');
  const rootId = parentRoot?.[1] ?? parent.id;
  const pTags = new Set([parent.pubkey, ...parent.tags.filter((tag) => tag[0] === 'p' && tag[1]).map((tag) => tag[1])]);
  const tags = rootId === parent.id ? [['e', parent.id, '', 'root', parent.pubkey]] : [['e', rootId, '', 'root'], ['e', parent.id, '', 'reply', parent.pubkey]];
  return [...tags, ...[...pTags].map((pubkey) => ['p', pubkey])];
}

function mergePublishTags(baseTags: string[][], extraTags: string[][]) {
  const seen = new Set<string>();
  return [...baseTags, ...extraTags].filter((tag) => {
    const key = `${tag[0] ?? ''}:${tag[1] ?? ''}:${tag[3] ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requireSession(message: string) {
  const currentSession = getStoreSnapshot(session);
  if (!currentSession) {
    loginDialogOpen.set(true);
    throw new Error(message);
  }
  return currentSession;
}

function getStoreSnapshot<T>(store: { subscribe(run: (value: T) => void): () => void }) {
  let value!: T;
  store.subscribe((next) => (value = next))();
  return value;
}

function selectedStore<TSource, TValue>(
  store: { subscribe(run: (value: TSource) => void): () => void },
  select: (value: TSource) => TValue,
  equal: (left: TValue, right: TValue) => boolean = Object.is
): Readable<TValue> {
  return {
    subscribe(run) {
      let current = select(getStoreSnapshot(store));
      run(current);
      return store.subscribe((value) => {
        const next = select(value);
        if (equal(current, next)) return;
        current = next;
        run(next);
      });
    }
  };
}

function statsEqual(left: EventStats, right: EventStats) {
  return (
    left.replies === right.replies &&
    left.reposts === right.reposts &&
    left.likes === right.likes &&
    left.zaps === right.zaps &&
    left.zapSats === right.zapSats &&
    left.dislikes === right.dislikes &&
    left.emoji === right.emoji
  );
}

function emptyStats(): EventStats {
  return { replies: 0, reposts: 0, likes: 0, zaps: 0, zapSats: 0, dislikes: 0, emoji: 0 };
}

function effectiveFeedSettings(mode: FeedMode): CustomFeedSettings {
  if (currentSessionValue && (mode === 'global' || mode === 'custom')) return currentSettings;
  return { ...currentSettings, interests: [] };
}

function feedRelaysForMode(mode: FeedMode) {
  return mode === 'global' ? defaultGlobalFeedRelays : currentRelays;
}

function mergeRelayHints(urls: string[], startingScore = 76) {
  const clean = [...new Set(urls.map(normalizeRelayUrl).filter(Boolean))].slice(0, 8);
  if (!clean.length) return;

  relays.update((existing) => {
    const normalizedExisting = existing.map((relay) => ({ ...relay, url: normalizeRelayUrl(relay.url) || relay.url }));
    const byUrl = new Map(normalizedExisting.map((relay) => [relay.url, relay]));
    const known = new Set(byUrl.keys());
    const additions = clean
      .filter((url) => !known.has(url))
      .map((url, index) => ({
        url,
        enabled: true,
        read: true,
        write: false,
        score: Math.max(55, startingScore - index)
      }));

    if (additions.length) return [...byUrl.values(), ...additions];
    const normalized = [...byUrl.values()];
    return normalized.some((relay, index) => relay.url !== existing[index]?.url) ? normalized : existing;
  });
}
