import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_BASE='https://v3.football.api-sports.io';
const DATABASE='api-football-odds';
const DEFAULT_APPROVED_LEAGUES=[39,40,41,42,43,61,62,71,78,79,88,94,98,103,106,113,119,128,135,136,140,141,144,169,179,180,183,184,197,203,207,208,218,235,244,253,262,283,357,483,1032];
const APPROVED_LEAGUES=new Set((process.env.MODEL_LEAGUE_IDS||DEFAULT_APPROVED_LEAGUES.join(',')).split(',').map(v=>Number(v.trim())).filter(Number.isInteger));
const ALLOWED=new Map([[1,new Set(['home','draw','away'])],[5,new Set(['over 2.5','under 2.5','over 3.5','under 3.5'])],[8,new Set(['yes','no'])]]);
const MAX_ODDS_JOBS=Math.max(1,Math.min(30,Number(process.env.MAX_ODDS_JOBS||20)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const iso=d=>d.toISOString();
const sqlValue=v=>v===null||v===undefined?'NULL':typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
let lastApiCall=0;

function requireEnv(name) { if (!process.env[name]) throw new Error(`Missing GitHub secret: ${name}`); }
function wrangler(args) {
  const command=process.platform==='win32'?'npx.cmd':'npx';
  const result=spawnSync(command,['wrangler',...args],{encoding:'utf8',maxBuffer:20*1024*1024,env:process.env});
  if (result.status!==0) throw new Error(`Wrangler failed: ${(result.stderr||result.stdout).slice(-4000)}`);
  return result.stdout;
}
function d1Query(sql) {
  const payload=JSON.parse(wrangler(['d1','execute',DATABASE,'--remote','--json',`--command=${sql}`]));
  return (Array.isArray(payload)?payload:[payload]).flatMap(block=>block.results||[]);
}
function d1Write(statements) {
  for (let i=0;i<statements.length;i+=200) {
    writeFileSync('collector-write.sql',`${statements.slice(i,i+200).join('\n')}\n`,'utf8');
    wrangler(['d1','execute',DATABASE,'--remote','--file','collector-write.sql']);
  }
}

async function apiGet(endpoint,params) {
  const url=new URL(`${API_BASE}/${endpoint}`); for (const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
  for (let attempt=0;attempt<4;attempt++) {
    const wait=1500-(Date.now()-lastApiCall); if (wait>0) await sleep(wait);
    const requestedAt=iso(new Date()); lastApiCall=Date.now(); let response,body,error=null;
    try {
      response=await fetch(url,{headers:{'x-apisports-key':process.env.API_FOOTBALL_KEY}}); body=await response.json();
      if (!response.ok||(body.errors&&Object.keys(body.errors).length)) throw new Error(JSON.stringify(body.errors||{http:response.status}));
    } catch (caught) { error=String(caught); }
    d1Write([`INSERT INTO cloud_api_requests(requested_at,endpoint,params_json,http_status,api_results,remaining_day,success,error_text) VALUES(${[requestedAt,endpoint,JSON.stringify(params),response?.status??null,body?.results??null,Number(response?.headers.get('x-ratelimit-requests-remaining'))||null,error?0:1,error].map(sqlValue).join(',')});`]);
    if (!error) return body.response||[];
    const limited=error.toLowerCase().includes('ratelimit')||error.toLowerCase().includes('too many requests');
    if (!limited||attempt===3) throw new Error(error); await sleep(5000*(attempt+1));
  }
}

function dateForSlot(now) {
  const minute=now.getUTCMinutes(); let offset;
  if (minute<15) offset=0; else if (minute<30) offset=1; else if (minute<45) offset=2; else offset=now.getUTCHours()%2===0?3:-1;
  return new Date(now.getTime()+offset*86400000).toISOString().slice(0,10);
}
function collectionInterval(minutes) { return minutes>720?120:minutes>180?60:15; }
function adaptiveTarget(minutes) {
  if (!Number.isFinite(minutes)||minutes<0||minutes>4320) return null;
  const interval=collectionInterval(minutes); return Math.ceil(minutes/interval)*interval;
}
function fixtureRecord(item) { return {
  fixture_id:Number(item.fixture.id),league_id:Number(item.league.id),season:item.league.season??null,kickoff_utc:item.fixture.date,
  status_short:item.fixture.status.short,home_team_id:item.teams.home.id??null,away_team_id:item.teams.away.id??null,
  home_team_name:item.teams.home.name??null,away_team_name:item.teams.away.name??null,goals_home:item.goals?.home??null,goals_away:item.goals?.away??null
}; }
function sameValue(a,b) { return (a===null||a===undefined?'':String(a))===(b===null||b===undefined?'':String(b)); }
function sameFixture(a,b) { return ['league_id','season','kickoff_utc','status_short','home_team_id','away_team_id','home_team_name','away_team_name','goals_home','goals_away'].every(k=>sameValue(a[k],b[k])); }

function existingFixtures(ids) {
  const result=new Map();
  for (let i=0;i<ids.length;i+=300) {
    const part=ids.slice(i,i+300); if (!part.length) continue;
    for (const row of d1Query(`SELECT fixture_id,league_id,season,kickoff_utc,status_short,home_team_id,away_team_id,home_team_name,away_team_name,goals_home,goals_away FROM cloud_fixtures WHERE fixture_id IN (${part.join(',')});`)) result.set(Number(row.fixture_id),row);
  }
  return result;
}
async function refreshFixtures(date) {
  const rows=await apiGet('fixtures',{date}); const updated=iso(new Date()); const records=rows.map(fixtureRecord);
  const existing=existingFixtures(records.map(r=>r.fixture_id)); const changed=records.filter(r=>!existing.has(r.fixture_id)||!sameFixture(r,existing.get(r.fixture_id)));
  const statements=changed.map(r=>{
    const values=[r.fixture_id,r.league_id,r.season,r.kickoff_utc,r.status_short,r.home_team_id,r.away_team_id,r.home_team_name,r.away_team_name,r.goals_home,r.goals_away,updated].map(sqlValue).join(',');
    return `INSERT INTO cloud_fixtures(fixture_id,league_id,season,kickoff_utc,status_short,home_team_id,away_team_id,home_team_name,away_team_name,goals_home,goals_away,updated_at) VALUES(${values}) ON CONFLICT(fixture_id) DO UPDATE SET league_id=excluded.league_id,season=excluded.season,kickoff_utc=excluded.kickoff_utc,status_short=excluded.status_short,home_team_id=excluded.home_team_id,away_team_id=excluded.away_team_id,home_team_name=excluded.home_team_name,away_team_name=excluded.away_team_name,goals_home=excluded.goals_home,goals_away=excluded.goals_away,updated_at=excluded.updated_at;`;
  });
  statements.push(`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('fixtures_last_date',${sqlValue(date)},${sqlValue(updated)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE cloud_sync_state.value IS NOT excluded.value;`);
  d1Write(statements); return {received:rows.length,changed:changed.length,unchanged:rows.length-changed.length};
}

function dueFixtures(now) {
  const end=iso(new Date(now.getTime()+73*3600000)); if (!APPROVED_LEAGUES.size) return [];
  const leagues=[...APPROVED_LEAGUES].sort((a,b)=>a-b).join(',');
  const rows=d1Query(`SELECT fixture_id,league_id,kickoff_utc FROM cloud_fixtures WHERE league_id IN (${leagues}) AND status_short IN ('NS','TBD') AND kickoff_utc>${sqlValue(iso(now))} AND kickoff_utc<=${sqlValue(end)} ORDER BY kickoff_utc LIMIT 800;`);
  const candidates=rows.map(row=>{const minutes=Math.floor((new Date(row.kickoff_utc)-now)/60000);return {...row,minutes,target:adaptiveTarget(minutes)};}).filter(r=>r.target!==null);
  const ids=[...new Set(candidates.map(r=>Number(r.fixture_id)))],prior=[];
  for (let i=0;i<ids.length;i+=300) { const part=ids.slice(i,i+300); if (part.length) prior.push(...d1Query(`SELECT fixture_id,target_minutes,status FROM cloud_collection_runs WHERE fixture_id IN (${part.join(',')});`)); }
  const terminal=new Set(prior.filter(r=>r.status==='completed'||r.status==='empty').map(r=>`${r.fixture_id}:${r.target_minutes}`));
  return candidates.filter(r=>!terminal.has(`${r.fixture_id}:${r.target}`)).slice(0,MAX_ODDS_JOBS);
}
function latestOdds(fixtureId) {
  const rows=d1Query(`SELECT bookmaker_id,bet_id,value_name,odds,api_updated_at FROM cloud_odds_snapshots WHERE fixture_id=${Number(fixtureId)} ORDER BY bookmaker_id,bet_id,value_name,COALESCE(api_updated_at,last_collected_at) DESC,rowid DESC;`),latest=new Map();
  for (const row of rows) { const key=`${row.bookmaker_id}:${row.bet_id}:${String(row.value_name).toLowerCase()}`; if (!latest.has(key)) latest.set(key,row); }
  return latest;
}
function changedOddsStatements(job,rows,started,latest) {
  const statements=[]; let seen=0,unchanged=0;
  for (const item of rows) for (const book of item.bookmakers||[]) for (const bet of book.bets||[]) {
    const names=ALLOWED.get(Number(bet.id)); if (!names) continue;
    for (const value of bet.values||[]) {
      const name=String(value.value); if (!names.has(name.toLowerCase())) continue; seen+=1;
      const key=`${book.id}:${bet.id}:${name.toLowerCase()}`,odds=String(value.odd),previous=latest.get(key);
      if (previous&&sameValue(previous.odds,odds)) { unchanged+=1; continue; }
      const apiUpdated=item.update||started,values=[job.fixture_id,book.id,book.name,bet.id,bet.name,name,odds,apiUpdated,started,started,job.minutes,job.minutes].map(sqlValue).join(',');
      statements.push(`INSERT INTO cloud_odds_snapshots(fixture_id,bookmaker_id,bookmaker_name,bet_id,bet_name,value_name,odds,api_updated_at,first_collected_at,last_collected_at,first_minutes_to_kickoff,last_minutes_to_kickoff) VALUES(${values}) ON CONFLICT(fixture_id,bookmaker_id,bet_id,value_name,api_updated_at) DO UPDATE SET odds=excluded.odds,last_collected_at=excluded.last_collected_at,last_minutes_to_kickoff=excluded.last_minutes_to_kickoff WHERE cloud_odds_snapshots.odds IS NOT excluded.odds;`);
      latest.set(key,{odds,api_updated_at:apiUpdated});
    }
  }
  return {statements,seen,unchanged};
}
async function collectOdds(job) {
  const started=iso(new Date());
  d1Write([`INSERT INTO cloud_collection_runs(fixture_id,target_minutes,started_at,minutes_to_kickoff,status) VALUES(${job.fixture_id},${job.target},${sqlValue(started)},${job.minutes},'running') ON CONFLICT(fixture_id,target_minutes) DO UPDATE SET started_at=excluded.started_at,minutes_to_kickoff=excluded.minutes_to_kickoff,status='running',error_text=NULL;`]);
  try {
    const change=changedOddsStatements(job,await apiGet('odds',{fixture:job.fixture_id}),started,latestOdds(job.fixture_id)); const status=change.seen?'completed':'empty';
    change.statements.push(`UPDATE cloud_collection_runs SET completed_at=${sqlValue(iso(new Date()))},status=${sqlValue(status)},values_received=${change.statements.length} WHERE fixture_id=${job.fixture_id} AND target_minutes=${job.target};`);
    d1Write(change.statements); return {changed:change.statements.length-1,unchanged:change.unchanged,seen:change.seen};
  } catch (error) {
    d1Write([`UPDATE cloud_collection_runs SET completed_at=${sqlValue(iso(new Date()))},status='failed',error_text=${sqlValue(String(error).slice(0,1000))} WHERE fixture_id=${job.fixture_id} AND target_minutes=${job.target};`]); return {changed:0,unchanged:0,seen:0};
  }
}

async function main() {
  for (const name of ['API_FOOTBALL_KEY','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID']) requireEnv(name);
  const now=new Date(),date=dateForSlot(now); d1Write([`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('github_heartbeat','started',${sqlValue(iso(now))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`]);
  try {
    const fixtures=await refreshFixtures(date),jobs=dueFixtures(now); let oddsChanged=0,oddsUnchanged=0,oddsSeen=0;
    for (const job of jobs) { const r=await collectOdds(job); oddsChanged+=r.changed; oddsUnchanged+=r.unchanged; oddsSeen+=r.seen; }
    d1Write([`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('github_heartbeat','completed',${sqlValue(iso(new Date()))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`]);
    console.log(JSON.stringify({ok:true,at:iso(now),fixture_date:date,approved_leagues:APPROVED_LEAGUES.size,fixtures_received:fixtures.received,fixtures_changed:fixtures.changed,fixtures_unchanged:fixtures.unchanged,odds_jobs:jobs.length,odds_values_seen:oddsSeen,odds_values_changed:oddsChanged,odds_values_unchanged:oddsUnchanged}));
  } catch (error) {
    d1Write([`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('github_error',${sqlValue(String(error).slice(0,1000))},${sqlValue(iso(new Date()))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`]); throw error;
  }
}

export { adaptiveTarget, changedOddsStatements, collectionInterval, fixtureRecord, sameFixture };
if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
