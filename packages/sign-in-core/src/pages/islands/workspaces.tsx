/** @jsxImportSource react */
import { Alert, AlertDescription } from '@agent-collaboration/tool-access-ui/ui/alert';
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@agent-collaboration/tool-access-ui/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@agent-collaboration/tool-access-ui/ui/field';
import { Input } from '@agent-collaboration/tool-access-ui/ui/input';
import { Textarea } from '@agent-collaboration/tool-access-ui/ui/textarea';
import { useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react';

import type { WorkspacesPageState } from '#sign-in-core/contracts/organization-shell-pages';
import {
	ConfirmAdminChangeStep,
	confirmAdminChangeDescription,
	confirmAdminChangeTitle,
} from '#sign-in-core/pages/islands/confirm-admin-change';
import { submitWorkspaceCreate } from '#sign-in-core/pages/islands/organization-admin-requests';
import { createWorkspaceLabel, WorkspacesView } from '#sign-in-core/pages/workspace-directory';

type CreatePhase =
	| { readonly kind: 'editing'; readonly message: string | null }
	| { readonly kind: 'sending' }
	| { readonly kind: 'confirming'; readonly request: CreateRequest };

interface CreateRequest {
	readonly name: string;
	readonly description: string;
}

/**
 * Create workspace, with the same outcomes as the owner CLI: an answered create reloads the
 * page's server read; a name in use is checked against this operation's own workspace first;
 * a corrected request after central answered gets a fresh operation ID.
 */
function CreateWorkspaceDialog(props: {
	readonly organizationId: string;
	readonly operationId: string;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [phase, setPhase] = useState<CreatePhase>({ kind: 'editing', message: null });
	const operationId = useRef(props.operationId);
	const confirmedOnce = useRef(false);

	async function send(request: CreateRequest): Promise<void> {
		setPhase({ kind: 'sending' });
		const result = await submitWorkspaceCreate({
			organizationId: props.organizationId,
			operationId,
			request,
			confirmedAlready: confirmedOnce.current,
		});
		switch (result.kind) {
			case 'created':
				// The directory is central's server read; reloading reads it again.
				location.reload();
				return;
			case 'confirm-again':
				setPhase({ kind: 'confirming', request });
				return;
			case 'not-created':
				setPhase({ kind: 'editing', message: result.message });
				return;
			default:
				result satisfies never;
		}
	}

	function submit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		if (phase.kind === 'sending') return;
		confirmedOnce.current = false;
		void send({ name, description });
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next: boolean): void => {
				setOpen(next);
				if (!next) setPhase({ kind: 'editing', message: null });
			}}
		>
			<Button type="button" className="self-start" onClick={() => setOpen(true)}>
				{createWorkspaceLabel}
			</Button>
			<DialogContent>
				{phase.kind === 'confirming' ? (
					<>
						<DialogHeader>
							<DialogTitle>{confirmAdminChangeTitle}</DialogTitle>
							<DialogDescription>
								{confirmAdminChangeDescription('create this workspace')}
							</DialogDescription>
						</DialogHeader>
						<ConfirmAdminChangeStep
							onConfirmed={(): void => {
								confirmedOnce.current = true;
								void send(phase.request);
							}}
						/>
					</>
				) : (
					<form onSubmit={submit} className="flex flex-col gap-4">
						<DialogHeader>
							<DialogTitle>Create workspace</DialogTitle>
						</DialogHeader>
						<FieldGroup>
							<Field>
								<FieldLabel htmlFor="workspace-name">Name</FieldLabel>
								<Input
									id="workspace-name"
									name="name"
									maxLength={256}
									required
									value={name}
									onChange={(event: ChangeEvent<HTMLInputElement>): void =>
										setName(event.target.value)
									}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="workspace-description">Description</FieldLabel>
								<Textarea
									id="workspace-description"
									name="description"
									maxLength={2048}
									value={description}
									onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
										setDescription(event.target.value)
									}
								/>
							</Field>
						</FieldGroup>
						{phase.kind === 'editing' && phase.message !== null && (
							<Alert role="alert" variant="destructive">
								<AlertDescription>{phase.message}</AlertDescription>
							</Alert>
						)}
						<DialogFooter>
							<DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
							<Button type="submit" disabled={phase.kind === 'sending'}>
								{createWorkspaceLabel}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** The browser's Workspaces page: the server's directory read and the interactive Create. */
export function Workspaces(props: {
	readonly organizationId: string;
	readonly state: WorkspacesPageState;
}): ReactElement {
	return (
		<WorkspacesView
			state={props.state}
			create={
				<CreateWorkspaceDialog
					organizationId={props.organizationId}
					operationId={props.state.operationId}
				/>
			}
		/>
	);
}
