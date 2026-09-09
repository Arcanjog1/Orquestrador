/** Public provider catalog verified 2026-09-09. These are model identities, never proof of account access.
 * https://developers.openai.com/api/docs/models/all
 * https://platform.claude.com/docs/en/models/overview
 */
export const OFFICIAL_MODELS = {
 openai: [
  {id:'gpt-6-astra',name:'GPT-6 Astra'},
  {id:'gpt-5.6-sol',name:'GPT-5.6 Sol'},
  {id:'gpt-5.6-terra',name:'GPT-5.6 Terra'},
  {id:'gpt-5.6-luna',name:'GPT-5.6 Luna'},
  {id:'gpt-5.5',name:'GPT-5.5'},
  {id:'gpt-5.3-codex-spark',name:'GPT-5.3 Codex Spark'},
 ],
 anthropic: [
  {id:'claude-fable-5-1',name:'Claude Fable 5.1'},
  {id:'claude-opus-5',name:'Claude Opus 5'},
  {id:'claude-sonnet-5',name:'Claude Sonnet 5'},
  {id:'claude-haiku-4-5-20251001',name:'Claude Haiku 4.5'},
 ],
} as const;

/** Claude Code model-specific effort support: https://code.claude.com/docs/en/model-config
 * Intersected with the installed CLI's declared flag values, never used to infer account access.
 */
export const CLAUDE_MODEL_EFFORTS:Readonly<Record<string,readonly string[]>> = {
 'claude-fable-5-1':['low','medium','high','xhigh','max'],
 'claude-opus-5':['low','medium','high','xhigh','max'],
 'claude-sonnet-5':['low','medium','high','xhigh','max'],
 'claude-haiku-4-5-20251001':[],
};
