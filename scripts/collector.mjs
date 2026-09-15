import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const API_BASE='https://v3.football.api-sports.io';
const DATABASE='api-football-odds';
const DEFAULT_APPROVED_LEAGUES=[39,40,41,42,43,61,62,71,78,79,88,94,98,103,106,113,119,128,135,136,140,141,144,169,179,180,183,184,197,203,207,208,218,235,244,253,262,283,357,483,1032];
const APPROVED_LEAGUES=new Set(
  (process.env.MODEL_LEAGUE_IDS||DEFAULT_APPROVED_LEAGUES.join(','))
    .split(',').map(value=>Number(value.trim())).filter(Number.isInteger)
);
const TARGETS=[4320,1440,720,360,180,60,15];
const ALLOWED=new Map([
  [1,new Set(['home','draw','away'])],
  [5,new Set(['over 2.5','under 2.5','over 3.5','under 3.5'])],
  [8,new Set(['yes','no'])]
]);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const iso=d=>d.toISOString();
const sqlValue=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;
let lastApiCall=0;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing GitHub secret: ${name}`);
}

function wrangler(args) {
  const command=process.platform==='win32'?'npx.cmd':'npx';
  const result=spawnSync(command,['wrangler',...args],{encoding:'utf8',maxBuffer:20*1024*1024,env:process.env});
  if (result.status!==0) throw new Error(`Wrangler failed: ${(result.stderr||result.stdout).slice(-4000)}`);
  return result.stdout;
}

function d1Query(sql) {
  const text=wrangler(['d1','execute',DATABASE,'--remote','--json',`--command=${sql}`]);
  const payload=JSON.parse(text); const blocks=Array.isArray(payload)?payload:[payload];
  return blocks.flatMap(block=>block.results||[]);
}

function d1Write(statements) {
  if (!statements.length) return;
  const chunks=[];
  for (let i=0;i<statements.length;i+=200) chunks.push(statements.slice(i,i+200));
  for (const chunk of chunks) {
    writeFileSync('collector-write.sql',`${chunk.join('\n')}\n`,'utf8');
    wrangler(['d1','execute',DATABASE,'--remote','--file','collector-write.sql']);
  }
}

async function apiGet(endpoint,params) {
  const url=new URL(`${API_BASE}/${endpoint}`);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  for (let attempt=0;attempt<4;attempt++) {
    const wait=1500-(Date.now()-lastApiCall); if (wait>0) await sleep(wait);
    const requestedAt=iso(new Date()); lastApiCall=Date.now();
    let response,body,error=null;
    try {
      response=await fetch(url,{headers:{'x-apisports-key':process.env.API_FOOTBALL_KEY}});
      body=await response.json();
      if (!response.ok || (body.errors&&Object.keys(body.errors).length)) throw new Error(JSON.stringify(body.errors||{http:response.status}));
    } catch (caught) { error=String(caught); }
    d1Write([`INSERT INTO cloud_api_requests(requested_at,endpoint,params_json,http_status,api_results,remaining_day,success,error_text) VALUES(${[
      requestedAt,endpoint,JSON.stringify(params),response?.status??null,body?.results??null,
      Number(response?.headers.get('x-ratelimit-requests-remaining'))||null,error?0:1,error
    ].map(sqlValue).join(',')});`]);
    if (!error) return body.response||[];
    const limited=error.toLowerCase().includes('ratelimit')||error.toLowerCase().includes('too many requests');
    if (!limited||attempt===3) throw new Error(error);
    await sleep(5000*(attempt+1));
  }
}

function dateForSlot(now) {
  const minute=now.getUTCMinutes(); let offset;
  if (minute<15) offset=0;
  else if (minute<30) offset=1;
  else if (minute<45) offset=2;
  else offset=now.getUTCHours()%2===0?3:-1;
  return new Date(now.getTime()+offset*86400000).toISOString().slice(0,10);
}

function dueTarget(minutes) {
  const possible=TARGETS.filter(target=>minutes>=target-14&&minutes<=target+30);
  return possible.sort((a,b)=>Math.abs(minutes-a)-Math.abs(minutes-b))[0];
}

async function refreshFixtures(date) {
  const rows=await apiGet('fixtures',{date}); const updated=iso(new Date()); const statements=[];
  for (const item of rows) {
    const values=[item.fixture.id,item.league.id,item.league.season,item.fixture.date,item.fixture.status.short,
      item.teams.home.id,item.teams.away.id,item.teams.home.name,item.teams.away.name,
      item.goals?.home??null,item.goals?.away??null,updated].map(sqlValue).join(',');
    statements.push(`INSERT INTO cloud_fixtures(fixture_id,league_id,season,kickoff_utc,status_short,home_team_id,away_team_id,home_team_name,away_team_name,goals_home,goals_away,updated_at) VALUES(${values}) ON CONFLICT(fixture_id) DO UPDATE SET league_id=excluded.league_id,season=excluded.season,kickoff_utc=excluded.kickoff_utc,status_short=excluded.status_short,home_team_id=excluded.home_team_id,away_team_id=excluded.away_team_id,home_team_name=excluded.home_team_name,away_team_name=excluded.away_team_name,goals_home=excluded.goals_home,goals_away=excluded.goals_away,updated_at=excluded.updated_at;`);
  }
  statements.push(`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('fixtures_last_date',${sqlValue(date)},${sqlValue(updated)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`);
  d1Write(statements); return {received:rows.length,stored:statements.length-1};
}

function dueFixtures(now) {
  const end=iso(new Date(now.getTime()+73*3600000));
  if (!APPROVED_LEAGUES.size) return [];
  const leagueIds=[...APPROVED_LEAGUES].sort((a,b)=>a-b).join(',');
  const rows=d1Query(`SELECT f.fixture_id,f.league_id,f.kickoff_utc FROM cloud_fixtures f WHERE f.league_id IN (${leagueIds}) AND f.status_short IN ('NS','TBD') AND f.kickoff_utc>${sqlValue(iso(now))} AND f.kickoff_utc<=${sqlValue(end)} ORDER BY f.kickoff_utc LIMIT 500;`);
  const candidates=[];
  for (const row of rows) {
    const minutes=Math.floor((new Date(row.kickoff_utc)-now)/60000); const target=dueTarget(minutes);
    if (!target) continue;
    candidates.push({...row,minutes,target});
  }
  if (!candidates.length) return [];
  const ids=[...new Set(candidates.map(row=>Number(row.fixture_id)))];
  const priorRows=d1Query(`SELECT fixture_id,target_minutes,status FROM cloud_collection_runs WHERE fixture_id IN (${ids.join(',')});`);
  const completed=new Set(priorRows.filter(row=>row.status==='completed').map(row=>`${row.fixture_id}:${row.target_minutes}`));
  const due=candidates.filter(row=>!completed.has(`${row.fixture_id}:${row.target}`)).slice(0,12);
  return due;
}

async function collectOdds(job) {
  const started=iso(new Date());
  d1Write([`INSERT INTO cloud_collection_runs(fixture_id,target_minutes,started_at,minutes_to_kickoff,status) VALUES(${job.fixture_id},${job.target},${sqlValue(started)},${job.minutes},'running') ON CONFLICT(fixture_id,target_minutes) DO UPDATE SET started_at=excluded.started_at,minutes_to_kickoff=excluded.minutes_to_kickoff,status='running',error_text=NULL;`]);
  try {
    const rows=await apiGet('odds',{fixture:job.fixture_id}); const statements=[];
    for (const item of rows) for (const book of item.bookmakers||[]) for (const bet of book.bets||[]) {
      const names=ALLOWED.get(Number(bet.id)); if (!names) continue;
      for (const value of bet.values||[]) {
        if (!names.has(String(value.value).toLowerCase())) continue;
        const values=[job.fixture_id,book.id,book.name,bet.id,bet.name,value.value,String(value.odd),item.update||started,started,started,job.minutes,job.minutes].map(sqlValue).join(',');
        statements.push(`INSERT INTO cloud_odds_snapshots(fixture_id,bookmaker_id,bookmaker_name,bet_id,bet_name,value_name,odds,api_updated_at,first_collected_at,last_collected_at,first_minutes_to_kickoff,last_minutes_to_kickoff) VALUES(${values}) ON CONFLICT(fixture_id,bookmaker_id,bet_id,value_name,api_updated_at) DO UPDATE SET odds=excluded.odds,last_collected_at=excluded.last_collected_at,last_minutes_to_kickoff=excluded.last_minutes_to_kickoff;`);
      }
    }
    const status=statements.length?'completed':'empty';
    statements.push(`UPDATE cloud_collection_runs SET completed_at=${sqlValue(iso(new Date()))},status=${sqlValue(status)},values_received=${statements.length} WHERE fixture_id=${job.fixture_id} AND target_minutes=${job.target};`);
    d1Write(statements); return statements.length-1;
  } catch (error) {
    d1Write([`UPDATE cloud_collection_runs SET completed_at=${sqlValue(iso(new Date()))},status='failed',error_text=${sqlValue(String(error).slice(0,1000))} WHERE fixture_id=${job.fixture_id} AND target_minutes=${job.target};`]);
    return 0;
  }
}

async function main() {
  for (const name of ['API_FOOTBALL_KEY','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID']) requireEnv(name);
  const now=new Date(); const date=dateForSlot(now);
  d1Write([`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('github_heartbeat','started',${sqlValue(iso(now))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`]);
  try {
    const fixtureRefresh=await refreshFixtures(date); const jobs=dueFixtures(now); let values=0;
    for (const job of jobs) values+=await collectOdds(job);
    d1Write([`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('github_heartbeat','completed',${sqlValue(iso(new Date()))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`]);
    console.log(JSON.stringify({
      ok:true,at:iso(now),fixture_date:date,
      fixtures:fixtureRefresh.stored,
      global_fixtures_received:fixtureRefresh.received,
      global_fixtures_stored:fixtureRefresh.stored,
      approved_leagues:APPROVED_LEAGUES.size,
      odds_jobs:jobs.length,values
    }));
  } catch (error) {
    d1Write([`INSERT INTO cloud_sync_state(key,value,updated_at) VALUES('github_error',${sqlValue(String(error).slice(0,1000))},${sqlValue(iso(new Date()))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`]);
    throw error;
  }
}

await main();
