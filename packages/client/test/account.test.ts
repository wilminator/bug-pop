import { describe, expect, it } from 'vitest';
import { loginUrl, personalizedAds, shownName, supporterBadge, wantsAds, type AccountStatus, type Me } from '../src/account';

const me = (over: Partial<Me> = {}): Me => ({ sub: 'u1', name: 'Jeanne', supporter: null, ads: true, ...over });
const signedIn = (m: Me): AccountStatus => ({ kind: 'signedIn', me: m });

describe('account display', () => {
  it('shows the name unless the player hid it', () => {
    expect(shownName(me())).toBe('Jeanne');
    expect(shownName(me({ name: undefined }))).toBeNull();
    expect(shownName(me({ settings: { privacy: { hide_name: true } } }))).toBeNull();
  });

  it('shows a supporter badge unless the player hid it', () => {
    expect(supporterBadge(me())).toBeNull();
    expect(supporterBadge(me({ supporter: { tier: 'explorer' } }))).toBe('Supporter');
    expect(supporterBadge(me({ supporter: { tier: 'adventurer' }, settings: { privacy: { hide_supporter: true } } }))).toBeNull();
  });

  it('builds the sign-in address with the page to come back to', () => {
    expect(loginUrl('/api/', '/?x=1')).toBe('/api/auth/login?return=%2F%3Fx%3D1');
  });
});

describe('ads rule', () => {
  it('never shows ads when the deployment has none (the open-source build)', () => {
    expect(wantsAds(false, { kind: 'off' })).toBe(false);
    expect(wantsAds(false, signedIn(me()))).toBe(false);
  });

  it('follows the account ads decision when signed in', () => {
    expect(wantsAds(true, signedIn(me({ ads: true })))).toBe(true);
    expect(wantsAds(true, signedIn(me({ ads: false, supporter: { tier: 'explorer' } })))).toBe(false);
  });

  it('shows ads to players who are not signed in', () => {
    expect(wantsAds(true, { kind: 'signedOut' })).toBe(true);
    expect(wantsAds(true, { kind: 'unavailable' })).toBe(true);
  });

  it('asks for non-personalized ads only when the account says so', () => {
    expect(personalizedAds({ kind: 'signedOut' })).toBeNull();
    expect(personalizedAds(signedIn(me()))).toBeNull();
    expect(personalizedAds(signedIn(me({ settings: { privacy: { personalized_ads: false } } })))).toBe(false);
    expect(personalizedAds(signedIn(me({ settings: { privacy: { personalized_ads: true } } })))).toBeNull();
  });
});
