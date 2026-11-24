import {
	describeChangeRecord,
	fleetAdminCreateWords,
	readChangeRecords,
	submitWorkspaceCreate,
	workspacesPageStateSchema,
	type ChangeRecordRow,
	type SendForwardedRequest,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/** One forwarding request the page sent, with its parsed body. */
export interface AdminPageRequest {
	readonly path: string;
	readonly body: unknown;
}

export interface OrganizationAdminPageDriver {
	/** Submits Create as the Workspaces page does; resolves with what the page then tells the
	 * person: the created words before its reload, or the message it shows instead. */
	readonly submitCreate: (fields: {
		readonly name: string;
		readonly description?: string;
	}) => Promise<string>;
	/** Every forwarding request the pages sent, in order, including the admin page's first read. */
	readonly requests: readonly AdminPageRequest[];
	/** The Organization admin page's change-records table, one line per row. */
	readonly changeRecordLines: () => readonly string[];
	/** How many times the Workspaces page reloaded (it does after a creation). */
	readonly reloads: () => number;
}

const workspacesIslandSchema = z.object({
	kind: z.literal('workspaces'),
	navigation: z.object({ activeOrganization: z.object({ organizationId: z.string() }) }),
	workspaces: workspacesPageStateSchema,
});

export function changeRecordLine(row: ChangeRecordRow): string {
	return `${row.when} ${row.change} ${row.subject} by ${row.origin}`;
}

async function servedPage(harness: Harness, cookie: string, path: string): Promise<string> {
	const page = await harness.auth(new URL(path, harness.issuer).toString(), {
		headers: { cookie },
	});
	if (page.status !== 200) throw new Error(`${path} answered ${String(page.status)}`);
	return page.text();
}

/**
 * The served Workspaces and Organization admin pages, with the decisions their islands make run
 * through the same sign-in-core functions the islands call. Each request goes to the real
 * sign-in routes with the person's cookie and origin; every answer comes from sign-in and,
 * through it, central. The rendering itself is proven in the browser host journeys.
 */
export async function openOrganizationAdminPage(props: {
	readonly harness: Harness;
	readonly cookie: string;
}): Promise<OrganizationAdminPageDriver> {
	const { harness } = props;
	const workspacesHtml = await servedPage(harness, props.cookie, '/workspaces');
	const island = createIsolatedPageDom(
		workspacesHtml,
		new URL('/workspaces', harness.issuer).toString(),
	).window.document.querySelector('[data-sign-in-island]');
	const state = workspacesIslandSchema.parse(
		JSON.parse(island?.getAttribute('data-island-state') ?? 'null'),
	);
	await servedPage(harness, props.cookie, '/organization-admin');
	const organizationId = state.navigation.activeOrganization.organizationId;
	const operationId = { current: state.workspaces.operationId };
	const requests: AdminPageRequest[] = [];
	let reloads = 0;
	const send: SendForwardedRequest = async (path, body) => {
		requests.push({ path, body });
		const answered = await harness.auth(new URL(path, harness.issuer).toString(), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				cookie: props.cookie,
				origin: new URL(harness.issuer).origin,
			},
			body: JSON.stringify(body),
		});
		return new Response(await answered.text(), {
			status: answered.status,
			headers: answered.headers,
		});
	};
	// The admin page reads its change records once on mount.
	const records = await readChangeRecords({ organizationId }, send);
	const lines =
		records.kind === 'answered'
			? records.result.records.map((record) => changeRecordLine(describeChangeRecord(record)))
			: [];
	return {
		requests,
		changeRecordLines: () => lines,
		reloads: () => reloads,
		async submitCreate(fields): Promise<string> {
			const result = await submitWorkspaceCreate({
				organizationId,
				operationId,
				request: { name: fields.name, description: fields.description ?? '' },
				confirmedAlready: false,
				send,
			});
			switch (result.kind) {
				case 'created':
					reloads += 1;
					return fleetAdminCreateWords.created;
				case 'confirm-again':
					return 'confirm-again';
				case 'not-created':
					return result.message;
				default:
					return result satisfies never;
			}
		},
	};
}
