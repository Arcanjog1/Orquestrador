/** A legacy family rule still applies when the UI saves a full Claude model ID.
 * Explicit version rules and agent allowedModels remain exact; this never aliases execution choices.
 */
export function modelMatchesRule(provider:string,rule:string,model:string):boolean {
 const a=rule.trim().toLowerCase(),b=model.trim().toLowerCase();
 return a===b||(provider==='anthropic'&&/^(fable|opus|sonnet|haiku)$/.test(a)&&b.startsWith('claude-'+a+'-'));
}
