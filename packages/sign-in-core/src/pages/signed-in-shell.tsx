/** @jsxImportSource react */
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarTrigger,
} from '@agent-collaboration/tool-access-ui/ui/sidebar';
import { ChevronDown, Folder, Laptop, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import type * as React from 'react';

import {
	signedInDestinations,
	type SignedInDestinationPath,
	type SignedInNavigationState,
	type SignedInShellPage,
} from '#sign-in-core/contracts/sign-in-navigation';

const destinationIcons: Readonly<Record<SignedInDestinationPath, LucideIcon>> = {
	'/me': UserRound,
	'/people': UsersRound,
	'/device': Laptop,
	'/workspaces': Folder,
};

export const signedInPageTitles: Readonly<Record<SignedInShellPage, string>> = {
	'/me': 'Me',
	'/people': 'People',
	'/device': 'Machines',
	'/workspaces': 'Workspaces',
	'/organization-admin': 'Organization admin',
};

export function SignedInShell(props: {
	readonly state: SignedInNavigationState;
	readonly switcher: React.ReactNode;
	readonly children: React.ReactNode;
}): React.ReactElement {
	const { page, destinations, activeOrganization } = props.state;
	return (
		<SidebarProvider className="flex-col [--sidebar-width:13rem] [--sidebar-width-icon:3rem]">
			<header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
				{/* The phone opens the same Sidebar as a Sheet; the desktop Sidebar is always open. */}
				<SidebarTrigger aria-label="Toggle navigation" className="md:hidden" />
				<span className="text-base font-semibold">Switchboard</span>
				<div className="ml-auto min-w-0">{props.switcher}</div>
			</header>
			<div className="flex min-w-0 flex-1">
				<Sidebar className="top-14 h-[calc(100svh-3.5rem)]">
					<SidebarContent>
						<SidebarGroup>
							<nav aria-label="Signed-in navigation">
								<SidebarMenu>
									{signedInDestinations
										.filter((destination) => destinations.includes(destination.path))
										.map((destination) => {
											const Icon = destinationIcons[destination.path];
											return (
												<SidebarMenuItem key={destination.path}>
													<SidebarMenuButton
														render={<a href={destination.path} />}
														aria-current={page === destination.path ? 'page' : undefined}
														isActive={page === destination.path}
														// The approved mockups mark the current destination in the primary colour.
														className="text-sm data-active:bg-primary data-active:text-primary-foreground hover:data-active:bg-primary hover:data-active:text-primary-foreground"
													>
														<Icon aria-hidden="true" />
														<span>{destination.label}</span>
													</SidebarMenuButton>
												</SidebarMenuItem>
											);
										})}
								</SidebarMenu>
							</nav>
						</SidebarGroup>
					</SidebarContent>
				</Sidebar>
				<SidebarInset className="min-w-0">
					<div className="flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-8">
						<div className="flex flex-col gap-0.5">
							<h1 className="text-2xl font-semibold">{signedInPageTitles[page]}</h1>
							{page !== '/me' && (
								<p className="text-sm text-muted-foreground">
									{activeOrganization.organizationName}
								</p>
							)}
						</div>
						{props.children}
					</div>
				</SidebarInset>
			</div>
		</SidebarProvider>
	);
}

export function organizationSwitcherButton(
	organizationName: string,
	disabled = false,
): React.ReactElement {
	return (
		<Button variant="outline" type="button" disabled={disabled} className="max-w-52">
			<span className="truncate">{organizationName}</span>
			<ChevronDown aria-hidden="true" />
		</Button>
	);
}
