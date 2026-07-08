export type NotificationPermissionState = NotificationPermission | 'unsupported';

export function getNotificationPermission(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return await Notification.requestPermission();
}

export function showDesktopNotification(
  title: string,
  body: string,
  onClick?: () => void,
): boolean {
  if (getNotificationPermission() !== 'granted') return false;
  const notification = new Notification(title, { body });
  if (onClick) notification.onclick = onClick;
  return true;
}
