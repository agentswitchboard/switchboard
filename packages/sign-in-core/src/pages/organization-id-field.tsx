/** @jsxImportSource react */
import { Field, FieldLabel } from '@agent-collaboration/tool-access-ui/ui/field';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@agent-collaboration/tool-access-ui/ui/input-group';
import { Check, Copy } from 'lucide-react';
import * as React from 'react';

/** The attribute a static page's copy script finds; the island copies through React instead. */
export const copyValueAttribute = 'data-copy-value';

export type CopyState = 'ready' | 'copied' | 'failed';

export const copyButtonLabels: Readonly<Record<CopyState, string>> = {
	ready: 'Copy',
	copied: 'Copied',
	failed: 'Copy failed',
};

/** The organization's ID as selectable text with a copy button. */
export function OrganizationIdField(props: {
	readonly organizationId: string;
	readonly copyState?: CopyState;
	readonly onCopy?: () => void;
}): React.ReactElement {
	const inputId = React.useId();
	const copyState = props.copyState ?? 'ready';
	return (
		<Field>
			<FieldLabel htmlFor={inputId}>Organization ID</FieldLabel>
			<InputGroup>
				<InputGroupInput id={inputId} readOnly value={props.organizationId} />
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						type="button"
						{...{ [copyValueAttribute]: props.organizationId }}
						aria-label="Copy organization ID"
						onClick={props.onCopy}
					>
						{copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
						<span aria-live="polite">{copyButtonLabels[copyState]}</span>
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
		</Field>
	);
}

/** The interactive field: one clipboard write per press, its outcome shown on the button. */
export function CopyableOrganizationId(props: {
	readonly organizationId: string;
	readonly copyText: (text: string) => Promise<void>;
}): React.ReactElement {
	const [copyState, setCopyState] = React.useState<CopyState>('ready');
	return (
		<OrganizationIdField
			organizationId={props.organizationId}
			copyState={copyState}
			onCopy={(): void => {
				props.copyText(props.organizationId).then(
					(): void => setCopyState('copied'),
					(): void => setCopyState('failed'),
				);
			}}
		/>
	);
}

/** For server-rendered pages without an island: the same button, the same outcome labels. */
export function organizationIdCopyScript(): string {
	return `<script>
for(const button of document.querySelectorAll('[${copyValueAttribute}]')){const label=button.querySelector('[aria-live]');
button.addEventListener('click',()=>{navigator.clipboard.writeText(button.getAttribute('${copyValueAttribute}')).then(()=>{label.textContent=${JSON.stringify(copyButtonLabels.copied)};},()=>{label.textContent=${JSON.stringify(copyButtonLabels.failed)};});});}
</script>`;
}
