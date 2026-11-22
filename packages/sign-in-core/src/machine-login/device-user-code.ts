/** The user code a Router shows for the device grant. Its alphabet and length
 * are Better Auth's to choose, so nothing here checks them: whether a value is
 * a real code is decided by the lookup (B3a's guard, then Better Auth's own
 * `/device` verify). People may type it with a hyphen or spaces, as shown. */
const deviceUserCodeMaximumLength = 64;
/** Characters that could give a value URL structure, and control characters.
 * The value only ever goes into an encoded query parameter on a fixed path;
 * refusing these keeps a URL- or path-shaped value out of the flow entirely. */
const urlCharacterPattern = /[/\\:?#&=%@\p{Cc}]/u;

/** The one normalization every lookup by user code applies: no hyphens or
 * spaces, uppercase. B3a's guard and the page's stored-code read both use it. */
export function normalizeDeviceUserCode(value: string): string {
	return value.replace(/[-\s]/gu, '').toUpperCase();
}

/** The normalized form of a typed or linked code, or null when it is empty,
 * longer than 64 characters once trimmed, or carries URL characters. */
export function parseDeviceUserCode(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length > deviceUserCodeMaximumLength || urlCharacterPattern.test(trimmed))
		return null;
	const normalized = normalizeDeviceUserCode(trimmed);
	return normalized === '' ? null : normalized;
}

/** Shows a code as the machine does: groups of four joined by a hyphen
 * (`ABCD-EFGH`), whatever its length. */
export function formatDeviceUserCode(code: string): string {
	return (code.match(/.{1,4}/gu) ?? []).join('-');
}
