/** @jsxImportSource react */
import { ConfirmSecondFactorStep } from '@agent-collaboration/auth-ui';
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@agent-collaboration/tool-access-ui/ui/card';
import type { ReactElement } from 'react';

export const confirmAdminChangeTitle = "Confirm it's you";

export function confirmAdminChangeDescription(action: string): string {
	return `Central needs a recent confirmation to ${action}.`;
}

/** The existing second-factor step; the caller retries its one request once it settles. */
export function ConfirmAdminChangeStep(props: { readonly onConfirmed: () => void }): ReactElement {
	return (
		<ConfirmSecondFactorStep
			labels={{
				appCodeDescription: 'Enter the code from your authenticator app.',
				confirm: 'Confirm',
				recoveryCode: 'Recovery code',
				recoveryCodeDescription: 'Enter one of your saved recovery codes.',
				useRecoveryCode: 'Use a recovery code instead',
				useAppCode: 'Use your authenticator app instead',
			}}
			onConfirmed={props.onConfirmed}
		/>
	);
}

/** Central asked for a recent second factor before a read. Cancel sends nothing. */
export function ConfirmAdminChange(props: {
	readonly action: string;
	readonly onConfirmed: () => void;
	readonly onCancel: () => void;
}): ReactElement {
	return (
		<Card data-admin-page-state="confirm-again">
			<CardHeader>
				<CardTitle>{confirmAdminChangeTitle}</CardTitle>
				<CardDescription>{confirmAdminChangeDescription(props.action)}</CardDescription>
			</CardHeader>
			<CardContent>
				<ConfirmAdminChangeStep onConfirmed={props.onConfirmed} />
			</CardContent>
			<CardFooter>
				<Button type="button" variant="outline" onClick={props.onCancel}>
					Cancel
				</Button>
			</CardFooter>
		</Card>
	);
}
