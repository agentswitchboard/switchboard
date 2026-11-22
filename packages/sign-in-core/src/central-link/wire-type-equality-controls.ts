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

type EquivalentWorkspace = { result: 'applied' } & { workspace: WorkspaceView_Serialize };
type OptionalTopLevel = Applied & { note?: string };
type OptionalNested = { result: 'applied'; workspace: WorkspaceView_Serialize & { note?: string } };
type OptionalUnionArm = {
	result: 'records';
	records: (Targeted | (Allowance & { note?: string }))[];
};
type OptionalWorkspace = { result: 'applied'; workspace?: WorkspaceView_Serialize };
type ActiveOnly = WorkspaceView_Serialize & { state: 'active' };
type ExtraTopLevelMatches = WireTypesEqual<Applied, OptionalTopLevel>;
type ExtraNestedMatches = WireTypesEqual<Applied, OptionalNested>;
type ExtraUnionArmMatches = WireTypesEqual<Records, OptionalUnionArm>;
type OptionalWorkspaceMatches = WireTypesEqual<Applied, OptionalWorkspace>;
type ActiveOnlyMatches = WireTypesEqual<WorkspaceView_Serialize, ActiveOnly>;

export type WireEqualityControls = [
	AssertWireType<WireTypesEqual<Applied, EquivalentWorkspace>>,
	// @ts-expect-error An optional top-level field changes the exact keys.
	AssertWireType<ExtraTopLevelMatches>,
	// @ts-expect-error An optional workspace field changes the nested keys.
	AssertWireType<ExtraNestedMatches>,
	// @ts-expect-error An optional field in one record arm changes the enclosing union.
	AssertWireType<ExtraUnionArmMatches>,
	// @ts-expect-error The producer workspace is required.
	AssertWireType<OptionalWorkspaceMatches>,
	// @ts-expect-error The producer accepts more than the active workspace state.
	AssertWireType<ActiveOnlyMatches>,
];
