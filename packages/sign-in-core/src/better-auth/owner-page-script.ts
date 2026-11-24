function scriptValue(value: string | null): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export function ownerPageScript(props: {
	readonly ready: boolean;
	readonly callback: string;
	readonly resume: string | null;
}): string {
	return `<script>
const form=document.getElementById('owner-sign-in');const statusElement=document.getElementById('status');
const ready=${JSON.stringify(props.ready)};let captchaState={kind:'empty'};let widgetId=null;
if(!ready){window.signInTurnstile='loading';
window.addEventListener('error',(event)=>{if(event.target?.id!=='sign-in-turnstile-script')return;window.signInTurnstile='failed';window.dispatchEvent(new Event('sign-in-turnstile-failed'));statusElement.textContent='Sign-in verification is unavailable.';},true);
window.onSignInTurnstileReady=()=>{window.signInTurnstile='ready';window.dispatchEvent(new Event('sign-in-turnstile-ready'));const container=document.getElementById('sign-in-captcha');
widgetId=window.turnstile.render(container,{sitekey:container.dataset.sitekey,action:container.dataset.action,size:'flexible',
callback:(token)=>{captchaState=typeof token==='string'&&token.length>0?{kind:'ready',token}:{kind:'empty'};},
'expired-callback':()=>{captchaState={kind:'empty'};},
'error-callback':()=>{captchaState={kind:'empty'};statusElement.textContent='Sign-in verification is unavailable.';}});};}
form?.addEventListener('submit',async(event)=>{event.preventDefault();
if(!ready&&(captchaState.kind!=='ready'||widgetId===null)){statusElement.textContent='Complete sign-in verification first.';return;}
const headers={'content-type':'application/json'};
if(!ready){headers['x-captcha-response']=captchaState.token;captchaState={kind:'in-flight'};}
try{
const body=ready?{}:{provider:event.submitter.value,callbackURL:${scriptValue(props.callback)}};
const response=await fetch(ready?'/api/auth/owner/bootstrap':'/api/auth/sign-in/social',{method:'POST',headers,body:JSON.stringify(body)});
const result=await response.json();if(!response.ok)throw new Error(ready?'Continuing to the management CLI was refused. Try again; if it keeps failing, start the sign-in again from the CLI.':'Sign-in was refused. Complete the verification, then try again.');
if(!ready){if(typeof result.url!=='string')throw new Error('Provider sign-in unavailable');location.assign(result.url);}
else if(result.kind==='complete'){const resume=${scriptValue(props.resume)};if(resume)location.assign(resume);else throw new Error('No CLI sign-in is waiting to continue.');}
else throw new Error('Owner bootstrap is incomplete');
}catch(error){delete statusElement.dataset.tone;statusElement.textContent=error instanceof Error?error.message:'Owner sign-in unavailable';}
finally{if(!ready&&widgetId!==null){captchaState={kind:'empty'};window.turnstile.reset(widgetId);}}});
</script><script>
const organizationForm=document.getElementById('create-organization');
if(organizationForm){const nameInput=organizationForm.elements.namedItem('organizationName');const slugInput=organizationForm.elements.namedItem('organizationSlug');let slugEdited=false;
slugInput.addEventListener('input',()=>{slugEdited=slugInput.value.length>0;});
nameInput.addEventListener('input',()=>{if(!slugEdited)slugInput.value=nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');});}
const confirmAgain=document.getElementById('confirm-second-factor-again');
if(confirmAgain)confirmAgain.addEventListener('click',()=>location.reload());
if(organizationForm)organizationForm.addEventListener('submit',async(event)=>{event.preventDefault();
if(confirmAgain)confirmAgain.hidden=true;
try{const fields=new FormData(organizationForm);
const response=await fetch('/api/auth/organization/create',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({name:fields.get('organizationName'),slug:fields.get('organizationSlug')})});
if(!response.ok){const failure=await response.json().catch(()=>null);
if(failure!==null&&typeof failure==='object'&&failure.code==='SECOND_FACTOR_REQUIRED'){if(confirmAgain)confirmAgain.hidden=false;throw new Error('Your confirmation has expired. Confirm with your app again to create the organization.');}
throw new Error('Organization creation was refused');}location.reload();
}catch(error){statusElement.textContent=error instanceof Error?error.message:'Organization creation unavailable';}});
</script><script>
(()=>{const retry=document.getElementById('retry-organization-provisioning');if(!retry)return;
retry.addEventListener('submit',async(event)=>{event.preventDefault();const button=retry.querySelector('button');button.disabled=true;
const state=document.getElementById('organization-setup-state');
try{const response=await fetch('/api/auth/organization/retry-provisioning',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({organizationId:retry.dataset.organizationId})});
const result=await response.json();if(response.ok&&result.kind==='ready'){state.textContent='Ready';retry.remove();}
else state.textContent="Switchboard still hasn't finished setting up your organization. Try again shortly.";
}catch{state.textContent="Switchboard couldn't be reached. Try again shortly.";}finally{button.disabled=false;}});})();
</script>`;
}
