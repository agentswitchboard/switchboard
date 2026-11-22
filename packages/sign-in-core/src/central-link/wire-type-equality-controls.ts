import type {
	OrganizationAdminResult_Serialize,
	OrganizationChangeRecord,
	WorkspaceView_Serialize,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';

type Applied = Extract<OrganizationAdminResult_Serialize, { result: 'applied' }>;
type Records = Extract<OrganizationAdminResult_Serialize, { result: 'records' }>;
type Allowance = Extract<OrganizationChangeRecord, { kind: 'machineAllowanceChanged' }>;
type Targeted = Exclude<OrganizationChangeRecord, Allowance>;

export type WireEqualityControls = [
	AssertWireType<
		WireTypesEqual<Applied, { result: 'applied' } & { workspace: WorkspaceView_Serialize }>
	>,
	// @ts-expect-error An optional top-level field changes the exact keys.
	AssertWireType<WireTypesEqual<Applied, Applied & { note?: string }>>,
	// @ts-expect-error An optional workspace field changes the nested keys.
	AssertWireType<
		WireTypesEqual<
			Applied,
			{ result: 'applied'; workspace: WorkspaceView_Serialize & { note?: string } }
		>
	>,
	// @ts-expect-error An optional field in one record arm changes the enclosing union.
	AssertWireType<
		WireTypesEqual<
			Records,
			{ result: 'records'; records: (Targeted | (Allowance & { note?: string }))[] }
		>
	>,
	// @ts-expect-error The producer workspace is required.
	AssertWireType<
		WireTypesEqual<Applied, { result: 'applied'; workspace?: WorkspaceView_Serialize }>
	>,
	// @ts-expect-error The producer accepts more than the active workspace state.
	AssertWireType<
		WireTypesEqual<WorkspaceView_Serialize, WorkspaceView_Serialize & { state: 'active' }>
	>,
];
