/** @jsxImportSource react */
import { Alert, AlertDescription } from '@agent-collaboration/tool-access-ui/ui/alert';
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import { Empty, EmptyDescription } from '@agent-collaboration/tool-access-ui/ui/empty';
import { Skeleton } from '@agent-collaboration/tool-access-ui/ui/skeleton';
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@agent-collaboration/tool-access-ui/ui/table';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { OrganizationChoice } from '#sign-in-core/contracts/organization-membership';
import type { OrganizationAdminPageState } from '#sign-in-core/contracts/organization-shell-pages';
import { ConfirmAdminChange } from '#sign-in-core/pages/islands/confirm-admin-change';
import {
	describeChangeRecord,
	readChangeRecords,
	retryOrganizationSetup,
	type ChangeRecordRow,
} from '#sign-in-core/pages/islands/organization-admin-requests';
import {
	ChangeRecordsCardView,
	fleetSetupLabel,
	OrganizationCardView,
	type FleetSetup,
} from '#sign-in-core/pages/organization-admin-view';
import { CopyableOrganizationId } from '#sign-in-core/pages/organization-id-field';

function OrganizationCard(props: {
	readonly organization: OrganizationChoice;
	readonly fleetSetup: FleetSetup;
}): ReactElement {
	const [fleetSetup, setFleetSetup] = useState(props.fleetSetup);
	const [retryMessage, setRetryMessage] = useState<string | null>(null);
	const [retrying, setRetrying] = useState(false);
	async function retry(): Promise<void> {
		setRetrying(true);
		const outcome = await retryOrganizationSetup(props.organization.organizationId);
		if (outcome.kind === 'ready') {
			setFleetSetup('ready');
			setRetryMessage(null);
		} else setRetryMessage(outcome.message);
		setRetrying(false);
	}
	return (
		<OrganizationCardView
			organization={props.organization}
			idField={
				<CopyableOrganizationId
					organizationId={props.organization.organizationId}
					copyText={(text) => navigator.clipboard.writeText(text)}
				/>
			}
			fleetSetupText={retryMessage ?? fleetSetupLabel(fleetSetup)}
			retry={
				fleetSetup === 'settingUp' && (
					<Button
						type="button"
						variant="outline"
						disabled={retrying}
						onClick={() => {
							void retry();
						}}
					>
						Try again
					</Button>
				)
			}
		/>
	);
}

type RecordsState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'listed'; readonly rows: readonly ChangeRecordRow[] }
	| { readonly kind: 'confirm-again' }
	| { readonly kind: 'not-confirmed' }
	| { readonly kind: 'failed'; readonly message: string };

function changeRecordsState(
	answer: Awaited<ReturnType<typeof readChangeRecords>>,
	confirmedOnce: boolean,
): RecordsState {
	switch (answer.kind) {
		case 'answered':
			return { kind: 'listed', rows: answer.result.records.map(describeChangeRecord) };
		case 'confirm-again':
			return confirmedOnce ? { kind: 'not-confirmed' } : { kind: 'confirm-again' };
		case 'refused':
			return { kind: 'failed', message: `Central refused: ${answer.reason}` };
		case 'unavailable':
			return { kind: 'failed', message: 'Change records are unavailable.' };
		default:
			return answer satisfies never;
	}
}

/** Central's change records, read once on mount; a second-factor request is confirmed once. */
function ChangeRecords(props: { readonly organizationId: string }): ReactElement {
	const [records, setRecords] = useState<RecordsState>({ kind: 'loading' });
	const [attempt, setAttempt] = useState(0);
	const confirmedOnce = useRef(false);
	useEffect(() => {
		let current = true;
		void readChangeRecords({ organizationId: props.organizationId }).then((answer): void => {
			if (current) setRecords(changeRecordsState(answer, confirmedOnce.current));
		});
		return (): void => {
			current = false;
		};
	}, [props.organizationId, attempt]);
	function reload(): void {
		setRecords({ kind: 'loading' });
		setAttempt((previous) => previous + 1);
	}

	if (records.kind === 'confirm-again')
		return (
			<ConfirmAdminChange
				action="read change records"
				onConfirmed={() => {
					confirmedOnce.current = true;
					reload();
				}}
				onCancel={() => setRecords({ kind: 'not-confirmed' })}
			/>
		);
	const retryable = records.kind === 'failed' || records.kind === 'not-confirmed';
	return (
		<ChangeRecordsCardView
			{...(retryable
				? {
						action: (
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									confirmedOnce.current = false;
									reload();
								}}
							>
								Try again
							</Button>
						),
					}
				: {})}
		>
			{records.kind === 'loading' ? (
				<Skeleton className="h-16 w-full" />
			) : records.kind === 'failed' ? (
				<Alert role="alert" variant="destructive">
					<AlertDescription>{records.message}</AlertDescription>
				</Alert>
			) : records.kind === 'not-confirmed' ? (
				<Alert role="alert" variant="destructive">
					<AlertDescription>Not confirmed; nothing was read.</AlertDescription>
				</Alert>
			) : records.rows.length === 0 ? (
				<Empty>
					<EmptyDescription>No changes recorded yet.</EmptyDescription>
				</Empty>
			) : (
				<Table aria-label="Change records">
					<TableHeader>
						<TableRow>
							<TableHead>When</TableHead>
							<TableHead>Change</TableHead>
							<TableHead>Subject</TableHead>
							<TableHead>By</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{records.rows.map((row) => (
							<TableRow key={row.id}>
								<TableCell>{row.when}</TableCell>
								<TableCell>{row.change}</TableCell>
								<TableCell>{row.subject}</TableCell>
								<TableCell>{row.origin}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</ChangeRecordsCardView>
	);
}

/** The browser's Organization admin page. */
export function OrganizationAdmin(props: {
	readonly organization: OrganizationChoice;
	readonly state: OrganizationAdminPageState;
}): ReactElement {
	return (
		<>
			<OrganizationCard organization={props.organization} fleetSetup={props.state.fleetSetup} />
			<ChangeRecords organizationId={props.organization.organizationId} />
		</>
	);
}
