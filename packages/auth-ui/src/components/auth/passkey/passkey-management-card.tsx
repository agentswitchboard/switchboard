import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@agent-collaboration/tool-access-ui/ui/card';
import { Skeleton } from '@agent-collaboration/tool-access-ui/ui/skeleton';
import type * as React from 'react';

export function PasskeyListSkeleton(): React.ReactElement {
	return <Skeleton aria-hidden="true" className="h-12 w-full" />;
}

export function PasskeyManagementCard({
	addAction,
	children,
	listRegionRef,
}: {
	readonly addAction: React.ReactNode;
	readonly children: React.ReactNode;
	readonly listRegionRef?: React.Ref<HTMLDivElement>;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader variant="divided">
				<CardTitle>
					<h2>Passkeys</h2>
				</CardTitle>
				<CardDescription>
					Add a passkey before replacing your app. You must always keep one working app or passkey.
				</CardDescription>
				<CardAction>{addAction}</CardAction>
			</CardHeader>
			<CardContent
				ref={listRegionRef}
				className="h-40 overflow-y-auto overscroll-contain sm:h-36"
				role="region"
				aria-label="Passkey list"
				tabIndex={0}
			>
				{children}
			</CardContent>
		</Card>
	);
}
