/** @jsxImportSource react */
import { ConfirmSecondFactorStep } from '@agent-collaboration/auth-ui';
import {
	Alert,
	AlertDescription,
	AlertTitle,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	Field,
	FieldLabel,
	Input,
} from '@agent-collaboration/tool-access-ui/server';
import { Checkbox } from '@agent-collaboration/tool-access-ui/ui/checkbox';
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@agent-collaboration/tool-access-ui/ui/table';
import { useRef, useState, type ReactElement } from 'react';

import type { DeviceApprovalPageState } from '#sign-in-core/contracts/device-approval-state';
import { formatDeviceUserCode } from '#sign-in-core/machine-login/device-user-code';
import {
	deviceDeniedCopy,
	deviceRefusalCopy,
	type DeviceOutcomeCopy,
} from '#sign-in-core/pages/device-approval-copy';
import {
	deviceDecisionOutcome,
	type DeviceDecisionOutcome,
} from '#sign-in-core/pages/islands/device-decision-outcome';

type Decision = 'approve' | 'deny';
type ReviewPhase =
	| { readonly kind: 'ready' }
	| { readonly kind: 'sending'; readonly decision: Decision }
	| {
			readonly kind: 'outcome';
			readonly decision: Decision;
			readonly outcome: DeviceDecisionOutcome;
	  };

export function DeviceApproval(props: {
	readonly state: DeviceApprovalPageState;
	readonly interactive: boolean;
	readonly onSessionEnded?: (path: string) => void;
}): ReactElement {
	const { state } = props;
	switch (state.kind) {
		case 'enter':
			return (
				<>
					<Card>
						<form method="get" action="/device" className="flex flex-col gap-4">
							<CardContent>
								<Field>
									<FieldLabel htmlFor="device-code-entry">Code shown on your machine</FieldLabel>
									<Input id="device-code-entry" name="user_code" autoComplete="off" required />
								</Field>
							</CardContent>
							<CardFooter>
								<Button type="submit">Continue</Button>
							</CardFooter>
						</form>
					</Card>
					{state.pending.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle>Pending logins</CardTitle>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Machine</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Action</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{state.pending.map(({ userCode, machineLabel }) => (
											<TableRow key={userCode}>
												<TableCell>{machineLabel}</TableCell>
												<TableCell>
													<Badge variant="outline">Waiting for approval</Badge>
												</TableCell>
												<TableCell>
													<Button
														variant="outline"
														nativeButton={false}
														render={
															<a href={`/device?user_code=${encodeURIComponent(userCode)}`} />
														}
													>
														Review
													</Button>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					)}
				</>
			);
		case 'review':
			return <ReviewDeviceApproval {...props} state={state} />;
		case 'approved':
			return <ApprovedDevice label={state.machineLabel} organization={state.organizationName} />;
		case 'refused':
			return (
				<DecisionMessage
					copy={deviceRefusalCopy[state.refusal]}
					state={state.refusal}
					retryHref={`/device?user_code=${encodeURIComponent(state.userCode)}`}
				/>
			);
		default:
			return state satisfies never;
	}
}

function ReviewDeviceApproval(props: {
	readonly state: Extract<DeviceApprovalPageState, { kind: 'review' }>;
	readonly interactive: boolean;
	readonly onSessionEnded?: (path: string) => void;
}): ReactElement {
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [phase, setPhase] = useState<ReviewPhase>({ kind: 'ready' });
	const pending = useRef(false);
	const { state } = props;
	async function submit(decision: Decision): Promise<void> {
		if (!props.interactive || pending.current) return;
		pending.current = true;
		setPhase({ kind: 'sending', decision });
		let outcome: DeviceDecisionOutcome;
		try {
			const response = await fetch(`/api/auth/machine-login/${decision}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userCode: state.userCode,
					...(decision === 'approve' ? { allowedWorkspaces: selected } : {}),
				}),
			});
			outcome = deviceDecisionOutcome(decision, response.status, await response.json());
		} catch {
			outcome = { kind: 'refused', refusal: 'unavailable' };
		}
		pending.current = false;
		if (outcome.kind === 'signed-out') {
			props.onSessionEnded?.(`/device?user_code=${encodeURIComponent(state.userCode)}`);
			return;
		}
		setPhase({ kind: 'outcome', decision, outcome });
	}
	if (phase.kind === 'outcome') {
		const { decision, outcome } = phase;
		switch (outcome.kind) {
			case 'approved':
				return (
					<ApprovedDevice
						label={outcome.label}
						organization={state.organizationName}
						workspaceCount={outcome.allowedWorkspaces.length}
					/>
				);
			case 'denied':
				return <DecisionMessage state="denied" copy={deviceDeniedCopy} />;
			case 'refused':
				return (
					<DecisionMessage
						state={outcome.refusal}
						copy={deviceRefusalCopy[outcome.refusal]}
						onRetry={() => {
							void submit(decision);
						}}
					/>
				);
			case 'confirm-again':
				return (
					<Card data-device-page-state="confirm-again">
						<CardHeader>
							<CardTitle>Confirm it's you</CardTitle>
							<CardDescription>
								{decision === 'approve' ? 'Approve' : 'Deny'} this login after confirming.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<ConfirmSecondFactorStep
								labels={{
									appCodeDescription: 'Enter the code from your authenticator app.',
									confirm: 'Confirm',
									recoveryCode: 'Recovery code',
									recoveryCodeDescription: 'Enter one of your saved recovery codes.',
									useRecoveryCode: 'Use a recovery code instead',
									useAppCode: 'Use your authenticator app instead',
								}}
								onConfirmed={() => {
									void submit(decision);
								}}
							/>
						</CardContent>
					</Card>
				);
			case 'signed-out':
				return (
					<Card>
						<CardContent>Your session ended.</CardContent>
					</Card>
				);
			default:
				return outcome satisfies never;
		}
	}
	const disabled = !props.interactive || phase.kind === 'sending';
	return (
		<Card data-device-page-state="review">
			<CardHeader>
				<CardTitle>Check the code on your machine</CardTitle>
				<CardDescription>
					{state.machineLabel} · {state.organizationName}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="font-mono text-3xl font-semibold">{formatDeviceUserCode(state.userCode)}</p>
				{state.workspaces === null ? (
					<Alert variant="destructive">
						<AlertDescription>
							Couldn't load workspaces. Reload this page to try again.
						</AlertDescription>
					</Alert>
				) : state.workspaces.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						This organization has no active workspaces.
					</p>
				) : (
					<fieldset disabled={disabled} className="flex flex-col gap-2">
						<legend className="mb-2 text-sm font-medium">Workspaces this machine can use</legend>
						{state.workspaces.map((workspace) => (
							<Field key={workspace.workspaceId} orientation="horizontal">
								<Checkbox
									id={`workspace-${workspace.workspaceId}`}
									disabled={disabled}
									checked={selected.includes(workspace.workspaceId)}
									onCheckedChange={(checked) =>
										setSelected(
											checked
												? [...selected, workspace.workspaceId]
												: selected.filter((id) => id !== workspace.workspaceId),
										)
									}
								/>
								<FieldLabel htmlFor={`workspace-${workspace.workspaceId}`}>
									{workspace.name}
								</FieldLabel>
							</Field>
						))}
					</fieldset>
				)}
			</CardContent>
			<CardFooter className="gap-2">
				<Button
					id="device-approve"
					disabled={disabled || state.workspaces === null}
					onClick={() => {
						void submit('approve');
					}}
				>
					Approve
				</Button>
				<Button
					id="device-deny"
					variant="outline"
					disabled={disabled}
					onClick={() => {
						void submit('deny');
					}}
				>
					Deny
				</Button>
			</CardFooter>
		</Card>
	);
}

function ApprovedDevice(props: {
	readonly label: string;
	readonly organization: string;
	readonly workspaceCount?: number;
}): ReactElement {
	return (
		<Card data-device-page-state="approved">
			<CardHeader>
				<CardTitle>Machine approved</CardTitle>
				<CardDescription>
					{props.label} · {props.organization}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<p>The machine can now finish logging in.</p>
				{props.workspaceCount !== undefined && <p>Workspaces approved: {props.workspaceCount}</p>}
			</CardContent>
			<CardFooter>
				<Button variant="outline" nativeButton={false} render={<a href="/me" />}>
					Back to your account
				</Button>
			</CardFooter>
		</Card>
	);
}

function DecisionMessage(props: {
	readonly state: string;
	readonly copy: DeviceOutcomeCopy;
	readonly retryHref?: string;
	readonly onRetry?: () => void;
}): ReactElement {
	const { action } = props.copy;
	return (
		<Card data-device-page-state={props.state}>
			<CardContent>
				<Alert variant={props.state === 'denied' ? 'default' : 'destructive'}>
					<AlertTitle>{props.copy.title}</AlertTitle>
					<AlertDescription>{props.copy.message}</AlertDescription>
				</Alert>
			</CardContent>
			<CardFooter>
				{action.kind === 'retry' && props.onRetry !== undefined ? (
					<Button type="button" onClick={props.onRetry}>
						{action.label}
					</Button>
				) : (
					<Button
						nativeButton={false}
						render={
							<a href={action.kind === 'link' ? action.href : (props.retryHref ?? '/device')} />
						}
					>
						{action.label}
					</Button>
				)}
			</CardFooter>
		</Card>
	);
}
