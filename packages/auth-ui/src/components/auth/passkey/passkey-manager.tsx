// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

/** Switchboard's passkey management: list, add, rename and remove. Composes
 * Better Auth UI's passkey hooks; removal is supplied by the host because the
 * sign-in service offers its own audited removal route. */
import { Alert } from '@agent-collaboration/tool-access-ui/ui/alert';
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import { EmptyDescription } from '@agent-collaboration/tool-access-ui/ui/empty';
import { Field, FieldError, FieldLabel } from '@agent-collaboration/tool-access-ui/ui/field';
import { Input } from '@agent-collaboration/tool-access-ui/ui/input';
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@agent-collaboration/tool-access-ui/ui/item';
import {
	PasskeyListSkeleton,
	PasskeyManagementCard,
} from '@auth-ui/components/auth/passkey/passkey-management-card';
import type { PasskeyAuthClient } from '@better-auth-ui/core/plugins/passkey';
import { useAuth } from '@better-auth-ui/react';
import {
	useAddPasskey,
	useListPasskeys,
	useUpdatePasskey,
} from '@better-auth-ui/react/plugins/passkey';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import type * as React from 'react';
import { useState } from 'react';

export interface PasskeyManagerProps {
	/** Removes one passkey through the host's removal route. */
	readonly removePasskey: (passkeyId: string) => Promise<void>;
	readonly labels: {
		readonly empty: string;
		readonly add: string;
		readonly rename: string;
		readonly save: string;
		readonly cancel: string;
		readonly remove: string;
		readonly name: string;
		readonly unnamed: string;
		readonly failed: string;
	};
}

const addedOn = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function PasskeyManager({ removePasskey, labels }: PasskeyManagerProps): React.ReactElement {
	// The provider is given a client built with passkeyClient(); a typed contract.
	const { authClient: passkeyClient } = useAuth<PasskeyAuthClient>();
	const queryClient = useQueryClient();
	const passkeys = useListPasskeys(passkeyClient);
	const addPasskey = useAddPasskey(passkeyClient);
	const updatePasskey = useUpdatePasskey(passkeyClient);
	const [editing, setEditing] = useState<{ readonly id: string; readonly name: string } | null>(
		null,
	);
	const [renameFailure, setRenameFailure] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [removingId, setRemovingId] = useState<string | null>(null);

	async function remove(passkeyId: string): Promise<void> {
		setFailure(null);
		setRemovingId(passkeyId);
		try {
			await removePasskey(passkeyId);
			await queryClient.invalidateQueries();
		} catch {
			setFailure(labels.failed);
		} finally {
			setRemovingId(null);
		}
	}

	function add(): void {
		setFailure(null);
		// The passkey client can resolve a cancellation or refusal as an error value.
		addPasskey
			.mutateAsync({})
			.then((result) => {
				if (result.error) setFailure(labels.failed);
			})
			.catch(() => setFailure(labels.failed));
	}

	return (
		<PasskeyManagementCard
			addAction={
				<Button type="button" variant="outline" disabled={addPasskey.isPending} onClick={add}>
					{labels.add}
				</Button>
			}
		>
			{passkeys.isPending && <PasskeyListSkeleton />}
			{passkeys.isError && <Alert variant="destructive">Passkeys are unavailable.</Alert>}
			{passkeys.isSuccess && (passkeys.data ?? []).length === 0 && (
				<EmptyDescription>{labels.empty}</EmptyDescription>
			)}
			<ItemGroup>
				{(passkeys.data ?? []).map((passkey) => (
					<Item key={passkey.id} role="listitem" size="sm" variant="outline">
						{editing?.id === passkey.id ? (
							<form
								className="flex w-full flex-col gap-2"
								onSubmit={(event): void => {
									event.preventDefault();
									setRenameFailure(null);
									updatePasskey
										.mutateAsync({ id: passkey.id, name: editing.name.trim() })
										.then(() => setEditing(null))
										.catch(() => setRenameFailure(labels.failed));
								}}
							>
								<Field data-invalid={renameFailure === null ? undefined : true}>
									<FieldLabel htmlFor={`passkey-name-${passkey.id}`}>{labels.name}</FieldLabel>
									<Input
										id={`passkey-name-${passkey.id}`}
										value={editing.name}
										aria-invalid={renameFailure === null ? undefined : true}
										aria-describedby={
											renameFailure === null ? undefined : `passkey-error-${passkey.id}`
										}
										onChange={(event): void =>
											setEditing({ id: passkey.id, name: event.target.value })
										}
										autoFocus
									/>
									<FieldError id={`passkey-error-${passkey.id}`}>{renameFailure}</FieldError>
								</Field>
								<ItemActions>
									<Button type="submit" variant="outline" disabled={updatePasskey.isPending}>
										{labels.save}
									</Button>
									<Button type="button" variant="ghost" onClick={(): void => setEditing(null)}>
										{labels.cancel}
									</Button>
								</ItemActions>
							</form>
						) : (
							<>
								<ItemMedia variant="icon">
									<KeyRound aria-hidden="true" />
								</ItemMedia>
								<ItemContent className="min-w-0">
									<ItemTitle className="break-all">{passkey.name ?? labels.unnamed}</ItemTitle>
									<ItemDescription>{addedOn.format(new Date(passkey.createdAt))}</ItemDescription>
								</ItemContent>
								<ItemActions>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={(): void => {
											setRenameFailure(null);
											setEditing({ id: passkey.id, name: passkey.name ?? '' });
										}}
									>
										{labels.rename}
									</Button>
									<Button
										type="button"
										variant="destructive"
										size="sm"
										disabled={removingId === passkey.id}
										onClick={(): void => {
											void remove(passkey.id);
										}}
									>
										{labels.remove}
									</Button>
								</ItemActions>
							</>
						)}
					</Item>
				))}
			</ItemGroup>
			{failure !== null && (
				<Alert role="alert" variant="destructive">
					{failure}
				</Alert>
			)}
		</PasskeyManagementCard>
	);
}
