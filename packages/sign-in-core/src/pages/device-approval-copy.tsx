/** The `/device` page's outcomes that end the approval. Each has one message,
 * what to do, and one action (WS6's rule for error states). */
export const deviceRefusals = [
	'expired',
	'not-permitted',
	'other-organization',
	'unknown-workspace',
	'request-conflict',
	'already-deciding',
	'unavailable',
] as const;
export type DeviceRefusal = (typeof deviceRefusals)[number];

export type DeviceOutcomeAction =
	| { readonly kind: 'link'; readonly label: string; readonly href: string }
	/** Unavailable is temporary: the action repeats what was refused. */
	| { readonly kind: 'retry'; readonly label: string };

export interface DeviceOutcomeCopy {
	readonly title: string;
	readonly message: string;
	readonly action: DeviceOutcomeAction;
}

export const deviceAccountLocation = '/me';
const backToAccount: DeviceOutcomeAction = {
	kind: 'link',
	label: 'Back to your account',
	href: deviceAccountLocation,
};

export const deviceRefusalCopy: Readonly<Record<DeviceRefusal, DeviceOutcomeCopy>> = {
	expired: {
		title: "This code can't be used",
		message:
			'It has expired or was already used. Start the login again on your machine to get a new code.',
		action: { kind: 'link', label: 'Enter a different code', href: '/device' },
	},
	'not-permitted': {
		title: "You can't approve machines here",
		message:
			"Your role in this machine's organization can't approve logins. Ask an owner to approve it.",
		action: backToAccount,
	},
	'other-organization': {
		title: 'This machine is in another organization',
		message:
			'It is already logged in to a different organization. Log it out there, then start the login again.',
		action: backToAccount,
	},
	'unknown-workspace': {
		title: "A workspace wasn't found",
		message: 'A workspace for this login no longer exists. Start the login again on your machine.',
		action: backToAccount,
	},
	'request-conflict': {
		title: 'This login was already approved with different details',
		message: 'Start a new login on your machine if you want to change the approval.',
		action: { kind: 'link', label: 'Enter a different code', href: '/device' },
	},
	'already-deciding': {
		title: 'This login is being decided',
		message: 'Review the request again to see its current status.',
		action: { kind: 'link', label: 'Open machine approvals', href: '/device' },
	},
	unavailable: {
		title: "Switchboard can't approve this right now",
		message: 'Try again shortly.',
		action: { kind: 'retry', label: 'Try again' },
	},
};

export const deviceDeniedCopy: DeviceOutcomeCopy = {
	title: 'Login denied',
	message: "The machine won't be logged in. You can close this page.",
	action: backToAccount,
};
