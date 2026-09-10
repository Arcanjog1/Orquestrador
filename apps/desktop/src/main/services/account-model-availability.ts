import type {AccountModelVerification} from '../../shared/model-availability.js';
import type {ModelCatalogEntry} from '../../shared/agent-policy.js';
import {availabilityOf} from '../../shared/model-availability.js';

export const UNVERIFIED_DETAIL = 'Não foi possível confirmar sem executar o modelo. O CLI não informa se esta conta tem acesso. Nenhuma chamada ao modelo foi feita.';
interface Store { get(key:string):string|null; set(key:string,value:string):void; }
const key = (accountId:string) => 'account-model-availability.' + accountId;
const validId = (id:unknown):id is string => typeof id==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(id);

/** Evidence is exact-model, exact-provider and exact-account. Neither aliases nor missing rows imply entitlement. */
export class AccountModelAvailability {
  constructor(private readonly store:Store) {}
  read(accountId:string,provider:string):AccountModelVerification|null {
    try {
      const value=JSON.parse(this.store.get(key(accountId))??'null') as AccountModelVerification|null;
      if(!value || value.accountId!==accountId || value.provider!==provider || !Array.isArray(value.confirmed) || !Array.isArray(value.denied) || ![...value.confirmed,...value.denied].every(validId)) return null;
      const age=Date.now()-Date.parse(value.checkedAt);
      return Number.isFinite(age)&&age>=0&&(value.evidence?.length||age<24*60*60*1000)?value:null;
    } catch { return null; }
  }
  write(accountId:string,value:AccountModelVerification):void {
    if(value.accountId!==accountId) throw new Error('A verificação pertence a outra conta.');
    this.store.set(key(accountId),JSON.stringify(value));
  }
  record(evidence:import('../../shared/model-availability.js').ModelVerificationEvidence):AccountModelVerification {
    const previous=this.read(evidence.accountId,evidence.providerId);
    const confirmed=(previous?.confirmed??[]).filter(id=>id!==evidence.modelId);
    const denied=(previous?.denied??[]).filter(id=>id!==evidence.modelId);
    if(evidence.state==='CONFIRMED_FOR_ACCOUNT')confirmed.push(evidence.modelId);
    if(evidence.state==='UNAVAILABLE')denied.push(evidence.modelId);
    const value:AccountModelVerification={accountId:evidence.accountId,provider:evidence.providerId,checkedAt:evidence.timestamp,confirmed,denied,detail:evidence.reason,evidence:[...(previous?.evidence??[]),evidence].slice(-200)};
    this.write(evidence.accountId,value);
    return value;
  }
  apply(accountId:string,provider:string,rows:ModelCatalogEntry[]):ModelCatalogEntry[] {
    const evidence=this.read(accountId,provider);
    return rows.map(row=>{
      const accountAllowed=row.provider!==provider?null:evidence?.denied.includes(row.id)?false:evidence?.confirmed.includes(row.id)?true:row.accountAllowed;
      const verification=evidence?.evidence?.filter(e=>e.modelId===row.id&&e.accountId===accountId&&e.providerId===provider).at(-1);
      return {...row,accountAllowed,availability:availabilityOf(accountAllowed),verification};
    });
  }
}

/** Only structured, account-scoped entitlement is evidence. Partial listings never deny omitted models. */
export function parseAccountModelListing(stdout:string,accountId:string):{confirmed:string[];denied:string[]}|null {
  let payload:unknown;
  try {payload=JSON.parse(stdout);} catch {return null;}
  if(!payload || typeof payload!=='object' || Array.isArray(payload))return null;
  const data=payload as Record<string,unknown>;
  if(data.accountId!==undefined && data.accountId!==accountId)return null;
  const entries=data.models??data.availableModels??data.entitlements;
  if(!Array.isArray(entries))return null;
  const confirmed:string[]=[],denied:string[]=[];
  for(const entry of entries) {
    if(typeof entry==='string') {if(data.scope==='account'&&validId(entry))confirmed.push(entry);continue;}
    if(!entry||typeof entry!=='object')continue;
    const row=entry as Record<string,unknown>,id=row.id??row.model??row.modelId;
    if(row.accountId!==undefined&&row.accountId!==accountId)continue;
    if(!validId(id))continue;
    const scoped=data.scope==='account'||data.accountId===accountId||row.accountId===accountId;
    const entitled=row.entitled??(scoped?(row.available??row.allowed):undefined);
    if(entitled===false)denied.push(id);
    else if(entitled===true || scoped)confirmed.push(id);
  }
  return confirmed.length||denied.length?{confirmed:[...new Set(confirmed)],denied:[...new Set(denied)]}:null;
}
