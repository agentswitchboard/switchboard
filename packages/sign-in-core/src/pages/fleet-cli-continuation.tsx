/** @jsxImportSource react */
import type { ReactElement } from 'react';

export function FleetCliContinuationNotice(): ReactElement {
	return (
		<p className="text-sm text-muted-foreground" data-fleet-cli-continuation>
			You’re signing in to the codex-router CLI. It can use your Fleet permissions for the selected
			organization, including managing workspaces and answering approvals as the owner.
		</p>
	);
}
