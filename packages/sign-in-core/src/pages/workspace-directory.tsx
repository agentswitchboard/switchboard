/** @jsxImportSource react */
import { Alert, AlertDescription } from '@agent-collaboration/tool-access-ui/ui/alert';
import { Badge } from '@agent-collaboration/tool-access-ui/ui/badge';
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import { Card, CardContent } from '@agent-collaboration/tool-access-ui/ui/card';
import { Empty, EmptyDescription } from '@agent-collaboration/tool-access-ui/ui/empty';
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@agent-collaboration/tool-access-ui/ui/table';
import type { ReactElement, ReactNode } from 'react';

import type {
	WorkspaceDirectory,
	WorkspacesPageState,
} from '#sign-in-core/contracts/organization-shell-pages';

type WorkspaceState = Extract<
	WorkspaceDirectory,
	{ kind: 'listed' }
>['workspaces'][number]['state'];

const workspaceStateLabels: Readonly<Record<WorkspaceState, string>> = {
	active: 'Active',
	archiving: 'Archiving',
	archived: 'Archived',
};

export const createWorkspaceLabel = 'Create workspace';

/** The organization's workspaces exactly as central listed them for this request. */
export function WorkspaceDirectoryTable(props: {
	readonly directory: WorkspaceDirectory;
}): ReactElement {
	const { directory } = props;
	switch (directory.kind) {
		case 'refused':
			return (
				<Alert variant="destructive">
					<AlertDescription>
						Central refused to list this organization's workspaces.
					</AlertDescription>
				</Alert>
			);
		case 'unavailable':
			return (
				<Alert variant="destructive">
					<AlertDescription>
						Couldn't load workspaces. Reload this page to try again.
					</AlertDescription>
				</Alert>
			);
		case 'listed':
			if (directory.workspaces.length === 0)
				return (
					<Empty className="border">
						<EmptyDescription>No workspaces yet.</EmptyDescription>
					</Empty>
				);
			return (
				<Card className="py-0">
					<CardContent className="px-0">
						<Table aria-label="Workspaces">
							<TableHeader>
								<TableRow>
									<TableHead className="pl-4">Workspace</TableHead>
									<TableHead className="pr-4 text-right">State</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{directory.workspaces.map((workspace) => (
									<TableRow key={workspace.workspaceId}>
										<TableCell className="pl-4 font-medium">{workspace.name}</TableCell>
										<TableCell className="pr-4 text-right">
											<Badge variant={workspace.state === 'active' ? 'secondary' : 'outline'}>
												{workspaceStateLabels[workspace.state]}
											</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			);
		default:
			return directory satisfies never;
	}
}

/** The page's layout: Create (for those allowed) above the directory. */
export function WorkspacesView(props: {
	readonly state: WorkspacesPageState;
	/** The interactive create control; the server render shows it disabled. */
	readonly create?: ReactNode;
}): ReactElement {
	return (
		<>
			{props.state.canCreate &&
				(props.create ?? (
					<Button type="button" className="self-start" disabled>
						{createWorkspaceLabel}
					</Button>
				))}
			<WorkspaceDirectoryTable directory={props.state.directory} />
		</>
	);
}
