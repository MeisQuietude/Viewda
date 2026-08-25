/** Returns a UTF-16 prefix without leaving a high surrogate at its end. */
export function codePointSafePrefix(value: string, length: number): string {
  let end = Math.min(value.length, Math.max(0, length));
  const last = value.charCodeAt(end - 1);
  if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
