/** Deterministic operation analysis. No model call and no inference from a
 * worker's success/failure: the user's requested operations own the contract. */
export type ObjectiveKind = 'READ_ONLY_QUERY' | 'CHANGE_REQUEST' | 'EXECUTION_REQUEST' | 'MIXED_REQUEST' | 'UNKNOWN_REQUEST';
export type ReadProofKind = 'REPOSITORY_ACCESS' | 'REPOSITORY_METADATA' | 'REPOSITORY_TREE' | 'FILE_EXISTENCE' | 'FILE_CONTENT' | 'COMMIT' | 'DIFF' | 'PR' | 'TEST_RESULT';
export interface ObjectiveIntent {
  kind: ObjectiveKind;
  operations: readonly ('read' | 'change' | 'execute')[];
  readProofs: readonly ReadProofKind[];
  targets: readonly string[];
  requiresChanges: boolean;
  requiresExecution: boolean;
  reasons: readonly string[];
}

export const normalizeObjective = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const words = (text: string) => normalizeObjective(text).match(/[a-z0-9_./-]+/g) ?? [];
const set = (text: string) => new Set(text.split(' '));
const changeVerbs = set('crie criar cria altere alterar altera corrija corrigir corrige ajuste ajustar remova remover remove implemente implementar implementa mude mudar muda modifique modificar conserte consertar adicione adicionar escreva escrever atualize atualizar renomeie renomear substitua substituir apague apagar edite editar salve salvar create change edit fix implement delete add write modify update rename replace save commit push merge');
const executeVerbs = set('rode rodar roda execute executar executa run execute launch start test compile compilar compile instale instalar install');
const readVerbs = set('leia ler read explique explicar explain analise analisar analyze analyse revise revisar review audite auditar audit liste listar list consulte consultar inspect inspecione inspecionar localize localizar encontre encontrar find mostre mostrar show veja ver see acessar acesse acesso acessivel abrir abra open confira conferir confirme confirmar confirm check');
const questions = set('onde quais qual como what where which how quem who');

/** Quoted examples and file names are data, not commands. Explicit imperative
 * changes anywhere (including conditional clauses) outrank an interrogative. */
export function classifyObjective(objective: string): ObjectiveIntent {
  const text=normalizeObjective(objective);
  const commandText=text.replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|'[^'\n]*'/g,' ');
  const tokens=words(commandText);
  const reasons:string[]=[], operations=new Set<'read'|'change'|'execute'>();
  const negative=set('nao nunca sem not never without');
  const active=(i:number)=> !negative.has(tokens[i-1]??'') && !(set('deve pode should must do').has(tokens[i-1]??'')&&negative.has(tokens[i-2]??''));
  // "Explain how to run/fix" asks for an explanation; "analyse and fix"
  // includes a separate imperative operation and still requires changes.
  const explanatory=/^(?:por favor\s+)?(?:explique|explain|como|how)\b/.test(commandText);
  const clauses=commandText.split(/\b(?:e|and|then|depois)\b|[;\n]/);
  const instructionTokens=explanatory ? clauses.slice(1).flatMap(words) : tokens;
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i]!;
    if(!active(i))continue;
    if(changeVerbs.has(token)&&instructionTokens.includes(token)) {operations.add('change');reasons.push('change:'+token);}
    if(executeVerbs.has(token)&&instructionTokens.includes(token)) {operations.add('execute');reasons.push('execute:'+token);}
    if(readVerbs.has(token)||questions.has(token))operations.add('read');
  }
  const buildRequested=/\b(?:faca|fazer|do|make|run|execute)\s+(?:o\s+|a\s+)?build\b/.test(commandText)||/^build\b/.test(commandText);
  const browserRequested=/\b(?:abra|abrir|open|launch)\s+(?:(?:o|no|in|the)\s+)*(?:navegador|browser)\b/.test(commandText);
  if(buildRequested||browserRequested) {operations.add('execute');reasons.push(buildRequested?'execute:build':'execute:browser');}
  // These nouns describe independently measurable query subjects.
  const proofs=new Set<ReadProofKind>();
  const has=(pattern:RegExp)=>pattern.test(commandText);
  if(has(/\b(acesso|acesse|acessar|acessivel|access|accessible|reach)\b/))proofs.add('REPOSITORY_ACCESS');
  if(has(/\b(branch|ramo|metadata|metadados|default branch)\b/))proofs.add('REPOSITORY_METADATA');
  if(has(/\b(commits|historico|history|log)\b/))proofs.add('COMMIT');
  if(has(/\b(diff|diferencas|compare|comparar)\b/))proofs.add('DIFF');
  if(has(/\b(pr|pull request)\b/))proofs.add('PR');
  if(has(/\b(existe|existir|exists|exist|existencia)\b/))proofs.add('FILE_EXISTENCE');
  if(has(/\b(arquivos|files|arvore|tree|diretorios|directories)\b/)||has(/\bo que (?:tem|ha)\b/))proofs.add('REPOSITORY_TREE');
  const listingCapability=has(/\b(?:consegue|pode|can)\b.*\b(?:ler|read)\b.*\b(?:arquivos|files)\b/)
    && !has(/\b(?:conteudo|contents|logica|logic|codigo|code|readme)\b|\.[a-z]{1,5}\b/);
  if(!listingCapability&&has(/\b(leia|ler|read|explique|explicar|explain|analise|analisar|review|audit|logica|logic|codigo|code|conteudo|contents)\b/))proofs.add('FILE_CONTENT');
  if(!proofs.size&&has(/\b(repo|repositorio|repository|github|projeto|project)\b/) && !operations.has('execute'))proofs.add('REPOSITORY_ACCESS');
  if(!proofs.size&&has(/\b(abra|abrir|open|ver|veja)\b/)&&!browserRequested)proofs.add('FILE_EXISTENCE');
  const interrogative=objective.trim().endsWith('?')||tokens.some(t=>questions.has(t));
  if(interrogative&&!operations.has('change')&&!operations.has('execute'))operations.add('read');
  if(proofs.size&&!operations.has('change')&&!operations.has('execute'))operations.add('read');
  // "open in browser" is execution, not a second request to read a file.
  if(browserRequested&&proofs.size===0)operations.delete('read');
  if(operations.has('read')&&!proofs.size)proofs.add('FILE_CONTENT');
  // A noun such as "code" in "remove this code" does not add a read operation.
  if(!operations.has('read'))proofs.clear();
  const kind:ObjectiveKind=operations.size>1?'MIXED_REQUEST':operations.has('change')?'CHANGE_REQUEST':operations.has('execute')?'EXECUTION_REQUEST':operations.has('read')?'READ_ONLY_QUERY':'UNKNOWN_REQUEST';
  const targets=[...new Set(objective.match(/(?:[\w.-]+\/)*[\w.-]+\.(?:md|txt|tsx?|jsx?|json|py|ya?ml|html|css|sh|sql)\b|\bREADME\b/gi)??[])];
  return {kind,operations:[...operations],readProofs:[...proofs],targets,requiresChanges:operations.has('change')||kind==='UNKNOWN_REQUEST',requiresExecution:operations.has('execute'),reasons:reasons.length?reasons:[kind==='UNKNOWN_REQUEST'?'unrecognised: retain change gate':'query structure and subject']};
}
