/** Bounded delegation context, separate from conversation history. */
export interface MissionBrief {
  expectedResult: string;
  acceptanceCriteria: string[];
  evidence: string[];
  relevantFiles: string[];
  constraints: string[];
  outOfScope: string[];
}

export function parseMission(value: unknown): MissionBrief | undefined {
  if(value == null)return undefined;
  if(typeof value!=='object'||Array.isArray(value))throw new Error('mission must be an object');
  const row=value as Record<string,unknown>;
  const arrays=['acceptanceCriteria','evidence','relevantFiles','constraints','outOfScope'] as const;
  if(Object.keys(row).some(k=>!['expectedResult',...arrays].includes(k)))throw new Error('Unknown mission field');
  if(typeof row.expectedResult!=='string'||!row.expectedResult.trim()||row.expectedResult.length>4000)throw new Error('mission needs a bounded expectedResult');
  for(const key of arrays)if(!Array.isArray(row[key])||row[key].length>30||!row[key].every(v=>typeof v==='string'&&v.trim()&&v.length<=2000))throw new Error('Invalid mission '+key);
  if(!(row.acceptanceCriteria as string[]).length)throw new Error('mission requires completion criteria');
  return {expectedResult:row.expectedResult,...Object.fromEntries(arrays.map(k=>[k,row[k]]))} as MissionBrief;
}

export const MISSION_SCHEMA={type:['object','null'],additionalProperties:false,
  required:['expectedResult','acceptanceCriteria','evidence','relevantFiles','constraints','outOfScope'],
  properties:{expectedResult:{type:'string'},acceptanceCriteria:{type:'array',items:{type:'string'}},
    evidence:{type:'array',items:{type:'string'}},relevantFiles:{type:'array',items:{type:'string'}},
    constraints:{type:'array',items:{type:'string'}},outOfScope:{type:'array',items:{type:'string'}}},
};
