import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  getNotificationPermission,
  requestNotificationPermission,
  showDesktopNotification,
} from '../notifications';

let originalNotification: unknown;

beforeEach(() => {
  originalNotification = (globalThis as any).Notification;
});

afterEach(() => {
  (globalThis as any).Notification = originalNotification;
});

type NotificationInstance = { title: string; body?: string; onclick: (() => void) | null };

function installFakeNotification(
  permission: 'default' | 'granted' | 'denied',
  requestResult?: 'default' | 'granted' | 'denied',
): NotificationInstance[] {
  const instances: NotificationInstance[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => requestResult ?? permission;
    onclick: (() => void) | null = null;
    constructor(
      public title: string,
      public options?: { body?: string },
    ) {
      instances.push({ title, body: options?.body, onclick: null });
    }
  }
  (globalThis as any).Notification = FakeNotification;
  return instances;
}

describe('getNotificationPermission', () => {
  test('returns "unsupported" when Notification is not defined', () => {
    (globalThis as any).Notification = undefined;
    expect(getNotificationPermission()).toBe('unsupported');
  });

  test('returns the current permission when supported', () => {
    installFakeNotification('granted');
    expect(getNotificationPermission()).toBe('granted');
  });
});

describe('requestNotificationPermission', () => {
  test('returns "unsupported" when Notification is not defined', async () => {
    (globalThis as any).Notification = undefined;
    expect(await requestNotificationPermission()).toBe('unsupported');
  });

  test('resolves with the result of Notification.requestPermission()', async () => {
    installFakeNotification('default', 'granted');
    expect(await requestNotificationPermission()).toBe('granted');
  });
});

describe('showDesktopNotification', () => {
  test('returns false and does not construct a Notification when permission is not granted', () => {
    const instances = installFakeNotification('denied');
    const result = showDesktopNotification('Title', 'Body');
    expect(result).toBe(false);
    expect(instances.length).toBe(0);
  });

  test('constructs a Notification and returns true when permission is granted', () => {
    const instances = installFakeNotification('granted');
    const result = showDesktopNotification('Title', 'Body');
    expect(result).toBe(true);
    expect(instances.length).toBe(1);
    expect(instances[0].title).toBe('Title');
    expect(instances[0].body).toBe('Body');
  });
});
