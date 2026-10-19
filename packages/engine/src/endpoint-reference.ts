/**
 * Return an opaque provider label that is safe to log and persist.
 *
 * RPC URLs are secret material in this project: credentials may appear in the
 * user-info, path, query, fragment, or even the host name. Keep the URL in the
 * transport only and collapse every URL-shaped value to a generic label.
 */
export function safeEndpointReference(value: string): string {
  const label = value.trim();
  if (
    label.length === 0
    || label.length > 80
    || /(?:\/\/|[/?#@]|%[0-9a-f]{2})/i.test(label)
    || !/^[a-z0-9._:-]+$/i.test(label)
  ) return 'rpc';
  return label;
}
