import type { CustomFeedSettings, RelayState } from './types';

export const defaultRelays: RelayState[] = [
  { url: 'wss://relay.nostr.com', enabled: true, read: true, write: true, score: 100 },
  { url: 'wss://relay.damus.io', enabled: true, read: true, write: true, score: 98 },
  { url: 'wss://nos.lol', enabled: true, read: true, write: true, score: 96 },
  { url: 'wss://nostr.bitcoiner.social', enabled: true, read: true, write: true, score: 94 },
  { url: 'wss://nostr.mom', enabled: true, read: true, write: true, score: 92 },
  { url: 'wss://relay.snort.social', enabled: true, read: true, write: true, score: 90 }
];

export const defaultGlobalFeedRelays: RelayState[] = [
  { url: 'wss://theforest.nostr1.com', enabled: true, read: true, write: true, score: 100 },
  { url: 'wss://pyramid.fiatjaf.com', enabled: true, read: true, write: true, score: 98 },
  { url: 'wss://nostr.wine', enabled: true, read: true, write: true, score: 96 }
];

export const defaultProfileRelays: RelayState[] = [
  { url: 'wss://nos.lol', enabled: true, read: true, write: true, score: 92 },
  { url: 'wss://relay.damus.io', enabled: true, read: true, write: true, score: 94 },
  { url: 'wss://relay.primal.net', enabled: true, read: true, write: true, score: 90 }
];

export const defaultCustomFeedSettings: CustomFeedSettings = {
  friendsOfFriends: false,
  keywords: [],
  interests: []
};

export const globalFeedHashtags = ['technology', 'food', 'foodstr', 'music', 'musicstr', 'introductions'];

export const globalFeedCuratorPubkey = 'c1fc7771f5fa418fd3ac49221a18f19b42ccb7a663da8f04cbbf6c08c80d20b1';

export const defaultGlobalFeedAuthors = [
  '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
  'e83b66a8ed2d37c07d1abea6e1b000a15549c69508fa4c5875556d52b0526c2b',
  '460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c',
  '76c71aae3a491f1d9eec47cba17e229cda4113a0bbb6e6ae1776d7643e29cafa',
  '683211bd155c7b764e4b99ba263a151d81209be7a566a2bb1971dc1bbd3b715e',
  'c1fc7771f5fa418fd3ac49221a18f19b42ccb7a663da8f04cbbf6c08c80d20b1'
];

export const socialInterests = [
  'art',
  'photography',
  'music',
  'food',
  'technology',
  'bitcoin',
  'nostr',
  'science',
  'books',
  'film',
  'gaming',
  'sports',
  'travel',
  'fitness',
  'nature',
  'fashion',
  'business',
  'politics',
  'education',
  'parenting'
];

export const interestHashtagMap: Record<string, string[]> = {
  art: ['art', 'artstr'],
  photography: ['photography', 'photostr'],
  music: ['music', 'musicstr'],
  food: ['food', 'foodstr'],
  nature: ['nature', 'naturestr']
};

export function keywordsForInterests(interests: string[]) {
  return [
    ...new Set(
      interests.flatMap((interest) => {
        const clean = interest.trim().toLowerCase();
        if (!clean) return [];
        return (interestHashtagMap[clean] ?? [clean]).map((tag) => `#${tag}`);
      })
    )
  ];
}

export const defaultGuestNip05 = 'benarc@nostr.com';

export const defaultPomegranateCentral = 'auth.njump.me';

// Public Google OAuth client ID used by the default Pomegranate coordinator.
export const defaultPomegranateGoogleClientId = '300561989816-7nv10jo4vdn0d6p9knf12g7rq4fcusnc.apps.googleusercontent.com';

export const defaultPomegranateOperators = ['po.njump.me', 'po.f7z.io', 'po.nostrver.se'];
