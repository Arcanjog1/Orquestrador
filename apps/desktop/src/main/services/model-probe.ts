import type {ProcessResult} from '../../../../../src/process/process-manager.js';
import type {ModelAvailability} from '../../shared/model-availability.js';

export const PROBE_PROMPT='Responda apenas OK. Não use ferramentas.';
export function probeArguments(provider:'openai'|'anthropic',model:string):string[] {
  if(provider==='anthropic')return ['--print','--model',model,'--output-format','json','--bare','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--max-turns','1','--system-prompt','Responda apenas OK.'];
  return ['exec','--model',model,'--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--sandbox','read-only',
    ...['approval_policy="never"','web_search="disabled"','features.shell_tool=false','features.unified_exec=false','features.multi_agent=false','features.apps=false','features.js_repl=false','features.apply_patch_freeform=false','features.image_generation=false','features.browser_use=false','features.memories=false','tools.view_image=false','project_doc_max_bytes=0','model_provider="openai"','model_providers.openai.request_max_retries=0','model_providers.openai.stream_max_retries=0'].flatMap(v=>['-c',v]),'-'];
}

/** Never interpret assistant prose, a generic 404 or generic access/rate errors as entitlement. */
export function classifyProbe(provider:'openai'|'anthropic',model:string,result:ProcessResult):{state:ModelAvailability;reason:string} {
  const unknown=(reason:string)=>({state:'KNOWN_BUT_UNVERIFIED' as const,reason});
  if(result.outcome==='timeout')return unknown('O teste excedeu o tempo limite. O acesso ao modelo continua não verificado.');
  if(result.outcome==='cancelled')return unknown('Teste cancelado. O acesso ao modelo continua não verificado.');
  if(result.outcome==='spawn-error')return unknown('Não foi possível iniciar o CLI. Verifique a instalação.');
  if(result.truncated)return unknown('A resposta do CLI ficou incompleta.');
  let events:Record<string,any>[];
  try {events=provider==='anthropic'?[JSON.parse(result.stdout)]:result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));}
  catch {return unknown(diagnostic(result.stderr));}
  if(events.some(e=>!e||typeof e!=='object'||Array.isArray(e)))return unknown('O CLI retornou uma resposta ilegível.');
  const errors=events.flatMap(e=>e.error?[e.error]:e.type==='error'?[e]:e.type==='result'&&e.is_error===true?[{message:e.result}]:[]);
  const exactMessages=[`The model '${model}' does not exist or you do not have access to it.`,`The '${model}' model is not supported when using Codex with a ChatGPT account.`,`There's an issue with the selected model (${model}). It may not exist or you may not have access to it.`];
  if(errors.some(e=>e&&typeof e==='object'&&((['model_not_found','model_not_available','model_not_allowed','unsupported_model','model_access_denied'].includes(e.code)&&(!e.model||e.model===model))||exactMessages.includes(e.message)))) {
    return {state:'UNAVAILABLE',reason:'O provider recusou explicitamente este modelo nesta conta.'};
  }
  if(result.exitCode!==0||errors.length)return unknown(diagnostic(result.stderr+' '+JSON.stringify(errors)));
  if(provider==='anthropic') {
    const e=events[0];
    const used=Object.keys(e?.modelUsage??{});
    if(e?.type==='result'&&e.subtype==='success'&&e.is_error===false&&e.result?.trim()==='OK'&&used.length===1&&used[0]===model)
      return {state:'CONFIRMED_FOR_ACCOUNT',reason:'Disponível nesta conta. Uma chamada mínima respondeu com o modelo solicitado.'};
  } else {
    const answer=events.find(e=>e.type==='item.completed'&&e.item?.type==='agent_message'&&e.item.text?.trim()==='OK');
    const completed=events.some(e=>e.type==='turn.completed'&&e.usage);
    const tool=events.some(e=>e.item&& !['agent_message','reasoning'].includes(e.item.type));
    // Direct exec receives --model unchanged; successful completion accepts that selection.
    // Explicit conflicting model telemetry always invalidates the evidence.
    const mismatch=events.some(e=>(e.model&&e.model!==model)||(e.item?.model&&e.item.model!==model));
    if(answer&&completed&&!tool&&!mismatch)return {state:'CONFIRMED_FOR_ACCOUNT',reason:'Disponível nesta conta. O Codex aceitou o modelo solicitado e respondeu ao teste.'};
  }
  return unknown('A resposta não comprovou o uso do modelo solicitado. Nenhum outro modelo foi testado.');
}
export function diagnostic(text:string):string {
  if(/rate.?limit|429/i.test(text))return 'O limite de uso foi atingido. Tente novamente mais tarde.';
  if(/unauthori[sz]ed|401|login|authentication|token.*expir/i.test(text))return 'A autenticação precisa ser renovada. Reconecte esta conta.';
  if(/ENOTFOUND|EAI_AGAIN|DNS|network|ECONN|fetch failed/i.test(text))return 'Não foi possível acessar o provider. Verifique a conexão com a internet.';
  if(/503|502|server|overload/i.test(text))return 'O serviço do provider está temporariamente indisponível.';
  return 'O CLI não retornou uma resposta válida. Verifique a conexão e a versão do runtime.';
}
