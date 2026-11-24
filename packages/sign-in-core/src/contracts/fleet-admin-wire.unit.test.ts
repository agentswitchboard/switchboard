import { expect, it } from 'vitest';

import {
	fleetAdminForwardingPaths,
	fleetAdminForwardingRoutes,
} from '#sign-in-core/contracts/fleet-admin-wire';

it('names each forwarding route by the operation it sends, in both directions', () => {
	// Arrange
	const byOperation = Object.entries(fleetAdminForwardingPaths).map(([operation, path]) => [
		path,
		operation,
	]);

	// Act
	const inverted = Object.fromEntries(byOperation);

	// Assert
	expect(inverted).toEqual(fleetAdminForwardingRoutes);
});
