/** @jsxImportSource react */
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Empty,
	EmptyDescription,
	Field,
	FieldDescription,
	FieldLabel,
	InputGroup,
	InputGroupInput,
	Skeleton,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@agent-collaboration/tool-access-ui/server';
import * as React from 'react';
import { z } from 'zod';

import {
	organizationPeopleListRequestSchema,
	organizationPeopleListReplySchema,
	organizationPersonLookupRequestSchema,
	organizationPersonLookupReplySchema,
	PEOPLE_PAGE_SIZE,
	type OrganizationPeopleListRequest,
	type OrganizationPersonLookupRequest,
} from '#sign-in-core/contracts/organization-membership';
import { createRequestLifecycle } from '#sign-in-core/pages/islands/request-lifecycle-transitions';
import type { OrganizationId } from '#sign-in-core/storage/models/sign-in-store';

// Local paging metadata travels with the lifecycle; it is never sent to the endpoint.
const listRequestSchema = organizationPeopleListRequestSchema.extend({
	knownTotal: z.number().int().nonnegative().nullable(),
});
const listReplySchema = z.discriminatedUnion('kind', [
	organizationPeopleListReplySchema.options[0].extend({
		offset: organizationPeopleListRequestSchema.shape.offset,
	}),
	organizationPeopleListReplySchema.options[1],
	organizationPeopleListReplySchema.options[2],
]);
const listLifecycle = createRequestLifecycle(listRequestSchema, listReplySchema);
const lookupLifecycle = createRequestLifecycle(
	organizationPersonLookupRequestSchema,
	organizationPersonLookupReplySchema,
);
type ListState = z.infer<typeof listLifecycle.stateSchema>;
type ListEvent = z.infer<typeof listLifecycle.eventSchema>;
type LookupState = z.infer<typeof lookupLifecycle.stateSchema>;
type LookupEvent = z.infer<typeof lookupLifecycle.eventSchema>;

export interface OrganizationPeopleTransport {
	readonly list: (request: OrganizationPeopleListRequest) => Promise<unknown>;
	readonly lookup: (request: OrganizationPersonLookupRequest) => Promise<unknown>;
}

function lookupMessage(state: LookupState): string {
	switch (state.kind) {
		case 'idle':
		case 'disposed':
			return '';
		case 'invalid':
			return 'Enter a valid email.';
		case 'pending':
			return 'Looking up…';
		case 'refused':
			return 'Lookup refused.';
		case 'unavailable':
			return 'Lookup unavailable. Try again.';
		case 'answered':
			switch (state.reply.kind) {
				case 'member':
					return `Member · ${state.reply.role === 'owner' ? 'Owner' : 'Member'}`;
				case 'invited':
					return 'Invited';
				case 'not-member':
					return 'Not a member';
				case 'refused':
				case 'unavailable':
					return '';
				default:
					return state.reply satisfies never;
			}
		default:
			return state satisfies never;
	}
}

function LoadingRows(): React.ReactElement {
	return (
		<TableRow>
			<TableCell colSpan={3}>
				<Skeleton aria-label="Loading people" className="h-12 w-full" />
			</TableCell>
		</TableRow>
	);
}

interface PeopleReplyDecision {
	readonly operation: 'lookup' | 'list';
	readonly generation: number;
	readonly outcome: 'applied' | 'discarded-as-stale';
}

/** Publish every decision after the render commits, even if React batches two replies. */
function useCommittedPeopleReplyDecisions(): (decision: PeopleReplyDecision) => void {
	const pending = React.useRef<
		{ readonly sequence: number; readonly decision: PeopleReplyDecision }[]
	>([]);
	const nextSequence = React.useRef(0);
	const [committedThrough, renderDecision] = React.useState(0);
	React.useEffect(() => {
		const firstUncommitted = pending.current.findIndex(
			({ sequence }) => sequence > committedThrough,
		);
		const committedCount = firstUncommitted === -1 ? pending.current.length : firstUncommitted;
		for (const { decision } of pending.current.splice(0, committedCount)) {
			if (typeof performance.mark !== 'function') continue;
			const name = `organization-people:${decision.operation}-handled`;
			performance.clearMarks(name);
			performance.mark(name, {
				detail: { generation: decision.generation, outcome: decision.outcome },
			});
		}
	}, [committedThrough]);
	return React.useCallback((decision: PeopleReplyDecision): void => {
		const sequence = ++nextSequence.current;
		pending.current.push({ sequence, decision });
		renderDecision(sequence);
	}, []);
}

/** Read-only table structure follows Better Auth UI's people tables at 2b028ec5;
 * independently composed with Switchboard's shared shadcn components. */
function OrganizationPeopleContent(props: {
	readonly organizationId: OrganizationId;
	readonly organizationName: string;
	readonly transport: OrganizationPeopleTransport;
	readonly cardTitle: 'shown' | 'page-heading';
}): React.ReactElement {
	const [list, renderList] = React.useState<ListState>(() => {
		const result = listLifecycle.transition(
			{ kind: 'idle', generation: 0 },
			{
				kind: 'submit-valid',
				request: listRequestSchema.parse({
					organizationId: props.organizationId,
					offset: 0,
					knownTotal: null,
				}),
			},
			{},
		);
		if (result.kind === 'refused') throw new Error('Initial people-list request was refused');
		return result.state;
	});
	const [lookup, renderLookup] = React.useState<LookupState>({ kind: 'idle', generation: 0 });
	const listReference = React.useRef<ListState>(list);
	const lookupReference = React.useRef<LookupState>(lookup);
	const [email, setEmail] = React.useState('');
	const recordDecision = useCommittedPeopleReplyDecisions();
	const applyList = React.useCallback(
		(event: ListEvent): ListState | null => {
			const result = listLifecycle.transition(listReference.current, event, {});
			if (result.kind === 'refused') {
				if (event.kind === 'reply' && result.reason === 'stale')
					recordDecision({
						operation: 'list',
						generation: event.generation,
						outcome: 'discarded-as-stale',
					});
				return null;
			}
			listReference.current = result.state;
			renderList(result.state);
			if (event.kind === 'reply')
				recordDecision({ operation: 'list', generation: event.generation, outcome: 'applied' });
			return result.state;
		},
		[recordDecision],
	);
	const applyLookup = React.useCallback(
		(event: LookupEvent): LookupState | null => {
			const result = lookupLifecycle.transition(lookupReference.current, event, {});
			if (result.kind === 'refused') {
				if (event.kind === 'reply' && result.reason === 'stale')
					recordDecision({
						operation: 'lookup',
						generation: event.generation,
						outcome: 'discarded-as-stale',
					});
				return null;
			}
			lookupReference.current = result.state;
			renderLookup(result.state);
			if (event.kind === 'reply')
				recordDecision({ operation: 'lookup', generation: event.generation, outcome: 'applied' });
			return result.state;
		},
		[recordDecision],
	);
	const readList = React.useCallback(
		async (pending: ListState): Promise<void> => {
			if (pending.kind !== 'pending') return;
			try {
				const reply = organizationPeopleListReplySchema.parse(
					await props.transport.list({
						organizationId: pending.request.organizationId,
						offset: pending.request.offset,
					}),
				);
				applyList({
					kind: 'reply',
					generation: pending.generation,
					reply: reply.kind === 'available' ? { ...reply, offset: pending.request.offset } : reply,
				});
			} catch {
				applyList({ kind: 'failed', generation: pending.generation });
			}
		},
		[props.transport, applyList],
	);
	function navigate(offset: number, knownTotal: number | null): void {
		const pending = applyList({
			kind: 'navigated',
			request: listRequestSchema.parse({
				organizationId: props.organizationId,
				offset,
				knownTotal,
			}),
		});
		if (pending !== null) void readList(pending);
	}
	async function readLookup(pending: LookupState): Promise<void> {
		if (pending.kind !== 'pending') return;
		try {
			const reply = organizationPersonLookupReplySchema.parse(
				await props.transport.lookup(pending.request),
			);
			applyLookup({ kind: 'reply', generation: pending.generation, reply });
		} catch {
			applyLookup({ kind: 'failed', generation: pending.generation });
		}
	}
	function submitLookup(nextEmail: string): void {
		const request = organizationPersonLookupRequestSchema.safeParse({
			organizationId: props.organizationId,
			email: nextEmail,
		});
		const pending = applyLookup(
			request.success
				? { kind: 'submit-valid', request: request.data }
				: { kind: 'submit-invalid' },
		);
		if (pending !== null) void readLookup(pending);
	}
	function pickEmail(nextEmail: string): void {
		setEmail(nextEmail);
		applyLookup({ kind: 'edited' });
		submitLookup(nextEmail);
	}
	React.useEffect(() => {
		void readList(listReference.current);
	}, [readList]);
	React.useEffect(
		() => (): void => {
			const listResult = listLifecycle.transition(listReference.current, { kind: 'unmounted' }, {});
			if (listResult.kind === 'next') listReference.current = listResult.state;
			const lookupResult = lookupLifecycle.transition(
				lookupReference.current,
				{ kind: 'unmounted' },
				{},
			);
			if (lookupResult.kind === 'next') lookupReference.current = lookupResult.state;
		},
		[],
	);

	const page = list.kind === 'answered' && list.reply.kind === 'available' ? list.reply : null;
	const offset = list.kind === 'pending' ? list.request.offset : (page?.offset ?? 0);
	const knownTotal =
		list.kind === 'pending' ? list.request.knownTotal : (page?.memberTotal ?? null);
	const nextOffset =
		page?.nextOffset ??
		(knownTotal !== null && offset + PEOPLE_PAGE_SIZE < knownTotal
			? offset + PEOPLE_PAGE_SIZE
			: null);
	return (
		<Card className="min-w-0">
			{props.cardTitle === 'shown' && (
				<CardHeader>
					<CardTitle>People</CardTitle>
					<CardDescription className="break-words">{props.organizationName}</CardDescription>
				</CardHeader>
			)}
			<CardContent className="flex min-w-0 flex-col gap-6">
				<section aria-labelledby="members-heading" className="min-w-0">
					<h2 id="members-heading" className="mb-3 text-sm font-medium">
						Members{page === null ? '' : ` (${page.memberTotal})`}
					</h2>
					<Table aria-label="Members">
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Email</TableHead>
								<TableHead>Role</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{list.kind === 'pending' ? (
								<LoadingRows />
							) : page === null ? (
								<TableRow>
									<TableCell colSpan={3}>
										<Empty>
											<EmptyDescription>
												{list.kind === 'refused'
													? 'People list refused.'
													: list.kind === 'unavailable'
														? 'People list unavailable. Try again.'
														: 'Loading people…'}
											</EmptyDescription>
										</Empty>
									</TableCell>
								</TableRow>
							) : page.members.length === 0 ? (
								<TableRow>
									<TableCell colSpan={3}>
										<Empty>
											<EmptyDescription>No members on this page.</EmptyDescription>
										</Empty>
									</TableCell>
								</TableRow>
							) : (
								page.members.map((member) => (
									<TableRow key={member.email} onClick={(): void => pickEmail(member.email)}>
										<TableCell className="max-w-32 whitespace-normal break-words">
											{member.name}
										</TableCell>
										<TableCell className="whitespace-normal">
											<Button
												type="button"
												variant="link"
												className="h-auto max-w-full px-0 text-left whitespace-normal break-all"
												aria-label={`Look up ${member.email}`}
												onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
													event.stopPropagation();
													pickEmail(member.email);
												}}
											>
												{member.email}
											</Button>
										</TableCell>
										<TableCell>
											<Badge variant="secondary">
												{member.role === 'owner' ? 'Owner' : 'Member'}
											</Badge>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
					<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={offset === 0}
							onClick={(): void => navigate(Math.max(0, offset - PEOPLE_PAGE_SIZE), knownTotal)}
						>
							Previous
						</Button>
						<span className="text-xs text-muted-foreground">
							Page {Math.floor(offset / PEOPLE_PAGE_SIZE) + 1}
						</span>
						<Button
							type="button"
							variant="outline"
							disabled={nextOffset === null}
							onClick={(): void => {
								if (nextOffset !== null) navigate(nextOffset, knownTotal);
							}}
						>
							Next
						</Button>
					</div>
					<p className="mt-2 text-xs text-muted-foreground">
						People who join or leave between pages may be skipped or shown twice.
					</p>
				</section>
				<section aria-labelledby="invitations-heading" className="min-w-0">
					<h2 id="invitations-heading" className="mb-3 text-sm font-medium">
						Invitations
					</h2>
					<Table aria-label="Invitations">
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{list.kind === 'pending' ? (
								<LoadingRows />
							) : page === null ? (
								<TableRow>
									<TableCell colSpan={3}>Invitations unavailable.</TableCell>
								</TableRow>
							) : page.invitations.length === 0 ? (
								<TableRow>
									<TableCell colSpan={3}>
										<Empty>
											<EmptyDescription>No pending invitations.</EmptyDescription>
										</Empty>
									</TableCell>
								</TableRow>
							) : (
								page.invitations.map((invitation) => (
									<TableRow
										key={invitation.email}
										onClick={(): void => pickEmail(invitation.email)}
									>
										<TableCell className="whitespace-normal">
											<Button
												type="button"
												variant="link"
												className="h-auto max-w-full px-0 text-left whitespace-normal break-all"
												aria-label={`Look up ${invitation.email}`}
												onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
													event.stopPropagation();
													pickEmail(invitation.email);
												}}
											>
												{invitation.email}
											</Button>
										</TableCell>
										<TableCell>
											<Badge variant="secondary">
												{invitation.role === 'owner' ? 'Owner' : 'Member'}
											</Badge>
										</TableCell>
										<TableCell>Invited</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</section>
				<form
					noValidate
					onSubmit={(event: React.FormEvent<HTMLFormElement>): void => {
						event.preventDefault();
						submitLookup(email);
					}}
					className="flex flex-col gap-3"
				>
					<Field>
						<FieldLabel htmlFor="membership-email">Email</FieldLabel>
						<InputGroup>
							<InputGroupInput
								id="membership-email"
								type="email"
								value={email}
								autoComplete="off"
								aria-invalid={lookup.kind === 'invalid'}
								aria-describedby="membership-email-help"
								onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
									setEmail(event.target.value);
									applyLookup({ kind: 'edited' });
								}}
							/>
						</InputGroup>
						<FieldDescription id="membership-email-help">
							Look up one person's membership in this organization.
						</FieldDescription>
					</Field>
					<Button type="submit" disabled={lookup.kind === 'pending'}>
						Look up
					</Button>
				</form>
				<div role="status" aria-live="polite" aria-label="Membership result" className="text-sm">
					{lookupMessage(lookup)}
				</div>
			</CardContent>
		</Card>
	);
}

/** A different organization gets fresh instances; cleanup disposes the old ones. */
export function OrganizationPeople(props: {
	readonly organizationId: OrganizationId;
	readonly organizationName: string;
	readonly transport: OrganizationPeopleTransport;
	/** The shell's page heading already names People and the organization. */
	readonly cardTitle?: 'shown' | 'page-heading';
}): React.ReactElement {
	return (
		<OrganizationPeopleContent
			key={props.organizationId}
			{...props}
			cardTitle={props.cardTitle ?? 'shown'}
		/>
	);
}
