/** @jsxImportSource react */
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@agent-collaboration/tool-access-ui/ui/card';
import { Skeleton } from '@agent-collaboration/tool-access-ui/ui/skeleton';
import type { ReactElement, ReactNode } from 'react';

import type { OrganizationChoice } from '#sign-in-core/contracts/organization-membership';
import {
	organizationSetupPendingMessage,
	type OrganizationAdminPageState,
} from '#sign-in-core/contracts/organization-shell-pages';
import { OrganizationIdField } from '#sign-in-core/pages/organization-id-field';

export type FleetSetup = OrganizationAdminPageState['fleetSetup'];

export function fleetSetupLabel(fleetSetup: FleetSetup): string {
	if (fleetSetup === 'ready') return 'Ready';
	if (fleetSetup === 'settingUp') return organizationSetupPendingMessage;
	return 'Not started';
}

export const changeRecordsTitle = 'Change records';
export const changeRecordsDescription = "The organization's latest 100 changes in Central.";

/** The organization's identity and Fleet setup. The caller supplies the live controls. */
export function OrganizationCardView(props: {
	readonly organization: OrganizationChoice;
	readonly idField: ReactNode;
	readonly fleetSetupText: string;
	readonly retry: ReactNode;
}): ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{props.organization.organizationName}</CardTitle>
				<CardDescription>
					{props.organization.role === 'owner' ? 'Owner' : 'Member'}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{props.idField}
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex flex-col gap-0.5">
						<span className="text-sm font-medium">Fleet setup</span>
						<span id="organization-setup-state" className="text-sm text-muted-foreground">
							{props.fleetSetupText}
						</span>
					</div>
					{props.retry}
				</div>
			</CardContent>
		</Card>
	);
}

export function ChangeRecordsCardView(props: {
	readonly action?: ReactNode;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{changeRecordsTitle}</CardTitle>
				<CardDescription>{changeRecordsDescription}</CardDescription>
				{props.action !== undefined && <CardAction>{props.action}</CardAction>}
			</CardHeader>
			<CardContent>{props.children}</CardContent>
		</Card>
	);
}

/** The server render: the same cards, controls disabled until the page's island mounts. */
export function OrganizationAdminFallback(props: {
	readonly organization: OrganizationChoice;
	readonly state: OrganizationAdminPageState;
}): ReactElement {
	return (
		<>
			<OrganizationCardView
				organization={props.organization}
				idField={<OrganizationIdField organizationId={props.organization.organizationId} />}
				fleetSetupText={fleetSetupLabel(props.state.fleetSetup)}
				retry={
					props.state.fleetSetup === 'settingUp' && (
						<Button type="button" variant="outline" disabled>
							Try again
						</Button>
					)
				}
			/>
			<ChangeRecordsCardView>
				<Skeleton className="h-16 w-full" />
			</ChangeRecordsCardView>
		</>
	);
}
