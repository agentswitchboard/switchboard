// Better Auth 1.7.11 types its extension field declarations against Zod 4.6.5.
// These fields carry values to the application's pinned Zod 4.4.3 validation.
import { z } from 'provider-zod';

import { machineDeviceFields } from '#sign-in-core/machine-login/machine-device-requests';

export const providerMachineExtensionFields = Object.fromEntries(
	Object.keys(machineDeviceFields).map((field) => [field, z.unknown().optional()]),
);
