import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { deviceApprovalSelectionSchema } from '#sign-in-core/machine-login/device-approval-claim';
import { deviceRefusals } from '#sign-in-core/pages/device-approval-copy';

const reviewFacts = {
	userCode: z.string(),
	machineLabel: z.string(),
	organizationName: z.string(),
};

export const deviceApprovalPageStateSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('enter'),
		pending: z.array(z.strictObject({ userCode: z.string(), machineLabel: z.string() })).readonly(),
	}),
	z.strictObject({ kind: z.literal('approved'), ...reviewFacts }),
	z.strictObject({
		kind: z.literal('recovering'),
		...reviewFacts,
		allowedWorkspaces: deviceApprovalSelectionSchema.shape.allowedWorkspaces,
	}),
	z.strictObject({
		kind: z.literal('review'),
		...reviewFacts,
		workspaces: z.array(z.strictObject({ workspaceId: uuid7Schema, name: z.string() })).nullable(),
	}),
	z.strictObject({
		kind: z.literal('refused'),
		refusal: z.enum(deviceRefusals),
		userCode: z.string(),
	}),
]);
export type DeviceApprovalPageState = z.infer<typeof deviceApprovalPageStateSchema>;
