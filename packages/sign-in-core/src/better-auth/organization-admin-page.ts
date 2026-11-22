import { fleetAdminForwardingRoutes } from '#sign-in-core/better-auth/fleet-admin-forwarding';
import { fleetAdminCreateWords } from '#sign-in-core/organizations/fleet-admin-create-words';

export const organizationAdminPagePath = '/organization-admin';

function escapeText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
function scriptValue(value: unknown): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * The owner page for B2's admin commands: create a workspace, list the organization's
 * workspaces and its change records. It holds no token or key. Each action posts to a
 * cookie-only forwarding route, and the server signs central's request. On
 * `secondFactorRequired` it runs the existing app-code or recovery-code confirmation, then
 * retries that one action once; a cancelled or failed confirmation sends nothing.
 */
export function organizationAdminPage(props: {
	readonly organizationId: string;
	readonly organizationName: string;
	/**
	 * UUIDv7 from the injected ID source: central's ledger key and, for a create, the
	 * workspace's ID. Kept on this page's retries after no answer; replaced once central has
	 * answered a create `nameInUse` or `conflict`, since a corrected request under the same ID
	 * is a conflict by design.
	 */
	readonly operationId: string;
	readonly showPeopleLink: boolean;
}): Response {
	const routes = Object.fromEntries(
		Object.entries(fleetAdminForwardingRoutes).map(([path, operation]) => [operation, path]),
	);
	const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Organization admin</title><main><h1>${escapeText(props.organizationName)}</h1>${props.showPeopleLink ? `<a href="/api/auth/organization/people?organizationId=${encodeURIComponent(props.organizationId)}">People</a>` : ''}<p role="status" id="status"></p><section id="step-up" hidden><h2>Confirm it's you</h2><p>Central needs a recent confirmation for this change.</p><form id="step-up-app"><label>App code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button type="submit">Confirm app</button></form><form id="step-up-recovery"><label>Recovery code <input name="code" autocomplete="off" required></label><button type="submit">Use recovery code</button></form><button type="button" id="step-up-cancel">Cancel</button></section><section><h2>Create a workspace</h2><form id="create-workspace"><label>Name <input name="name" maxlength="256" required></label><label>Description <textarea name="description" maxlength="2048"></textarea></label><button type="submit">Create workspace</button></form></section><section><h2>Workspaces</h2><ul id="workspaces"></ul></section><section><h2>Change records</h2><ul id="change-records"></ul></section></main><script>
(()=>{const organizationId=${scriptValue(props.organizationId)};let operationId=${scriptValue(props.operationId)};
function freshOperationId(){const bytes=crypto.getRandomValues(new Uint8Array(16));let time=Date.now();for(let index=5;index>=0;index-=1){bytes[index]=time%256;time=Math.floor(time/256);}
bytes[6]=(bytes[6]&15)|112;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map((byte)=>byte.toString(16).padStart(2,'0')).join('');
return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);}const routes=${scriptValue(routes)};
const statusElement=document.getElementById('status');const stepUp=document.getElementById('step-up');
function say(text){statusElement.textContent=text;}
async function forward(operation,body){const response=await fetch(routes[operation],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const result=await response.json().catch(()=>null);return {ok:response.ok,result};}
function confirmation(){stepUp.hidden=false;return new Promise((resolve)=>{
const finish=(confirmed)=>{stepUp.hidden=true;for(const form of stepUp.querySelectorAll('form'))form.reset();resolve(confirmed);};
const submit=(form,path)=>async(event)=>{event.preventDefault();
try{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});finish(response.ok);}catch{finish(false);}};
const app=document.getElementById('step-up-app');const recovery=document.getElementById('step-up-recovery');
app.onsubmit=submit(app,'/api/auth/two-factor/verify-totp');recovery.onsubmit=submit(recovery,'/api/auth/two-factor/verify-backup-code');
document.getElementById('step-up-cancel').onclick=()=>finish(false);});}
async function admin(operation,body){let answer=await forward(operation,body);
if(answer.ok&&answer.result?.result==='refused'&&answer.result.reason==='secondFactorRequired'){
if(!(await confirmation()))return {kind:'not-confirmed'};answer=await forward(operation,body);}
if(!answer.ok)return {kind:'unavailable'};if(answer.result?.result==='refused')return {kind:'refused',reason:answer.result.reason};
return {kind:'answered',result:answer.result};}
function item(list,text){const entry=document.createElement('li');entry.textContent=text;list.append(entry);}
async function load(){const records=await admin('ReadChangeRecords',{organizationId,after:null,limit:100});
if(records.kind!=='answered'){say(records.kind==='refused'?'Central refused: '+records.reason:'Change records are unavailable.');return;}
const recordList=document.getElementById('change-records');const workspaceList=document.getElementById('workspaces');
recordList.replaceChildren();workspaceList.replaceChildren();
for(const record of records.result.records){
const subject=record.kind==='machineAllowanceChanged'?record.machineId+' '+record.workspaceId+' ('+record.state+')':record.targetId;
const origin=record.origin.kind==='person'?' by '+record.origin.personId+' ('+record.origin.permissionChecked+')':record.origin.kind==='automatic'?' automatically in Central':' by sign-in';
item(recordList,new Date(record.createdAtMillis).toISOString()+' '+record.kind+' '+subject+origin);}
const workspaceIds=[...new Set(records.result.records.filter((record)=>record.kind==='workspaceCreated').map((record)=>record.targetId))];
for(const workspaceId of workspaceIds){const found=await admin('WorkspaceLookup',{organizationId,workspaceId});
if(found.kind==='answered'&&found.result.workspace!==null)item(workspaceList,found.result.workspace.name+' ('+found.result.workspace.state+')');}}
const create=document.getElementById('create-workspace');create.addEventListener('submit',async(event)=>{event.preventDefault();
const button=create.querySelector('button');button.disabled=true;
try{const fields=new FormData(create);const name=fields.get('name');const created=await admin('CreateWorkspace',{organizationId,operationId,name,description:fields.get('description')});
if(created.kind==='answered'){say(${scriptValue(fleetAdminCreateWords.created)});location.reload();}
else if(created.kind==='refused'&&created.reason==='nameInUse'){
const own=await admin('WorkspaceLookup',{organizationId,workspaceId:operationId});
if(own.kind==='answered'&&own.result.workspace!==null&&own.result.workspace.name===name){say(${scriptValue(fleetAdminCreateWords.created)});location.reload();}
else{say(${scriptValue(fleetAdminCreateWords.nameInUse)});operationId=freshOperationId();}}
else if(created.kind==='refused'&&created.reason==='conflict'){say(${scriptValue(fleetAdminCreateWords.conflict)});operationId=freshOperationId();}
else say(created.kind==='refused'?'Central refused: '+created.reason:created.kind==='not-confirmed'?'Not confirmed; nothing was sent.':'Central is unavailable. Try again.');
}catch{say('Central is unavailable. Try again.');}finally{button.disabled=false;}});
load().catch(()=>say('Change records are unavailable.'));})();
</script></html>`;
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		},
	});
}
