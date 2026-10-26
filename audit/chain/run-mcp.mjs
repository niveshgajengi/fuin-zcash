// Drive the built stdio server with the same real SDK transport as mcp.test.ts.
// The driver never reads deployment records or supplies wallet/key settings.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { Client } = await import(pathToFileURL(resolve('packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(resolve('packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const root=process.cwd(), rows=[];
const scrub=s=>s.replace(/(?:uivk|ufvk|uview|uviews|utest1|secret-extended-key|zxviews)[a-z0-9]{20,}/gi,'[REDACTED]');
function record(id,ok,result,note,status) {
  const evidence=`audit/chain/${id}.txt`;
  writeFileSync(evidence,scrub(JSON.stringify(result,null,2))+'\n');
  rows.push({id,status:status??(ok?'PASS':'FAIL'),evidence,note:scrub(note)});
  writeFileSync('audit/chain/mcp-results.json',JSON.stringify(rows,null,2)+'\n');
  console.log(id,rows.at(-1).status,note);
}
async function connect(file) {
  const c=new Client({name:'fuin-readonly-audit',version:'1'});
  const env={PATH:process.env.PATH??'',HOME:process.env.HOME??''};
  if(file) env.SBA_AUCTION_FILE=resolve(file);
  await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/main.js')],env,stderr:'pipe'}));
  return c;
}
async function call(c,name,args={}) {
  try {
    const r=await c.callTool({name,arguments:args},undefined,{timeout:180000});
    return {isError:!!r.isError,text:r.content?.[0]?.text??''};
  } catch(e) { return {isError:true,text:e.message}; }
}
async function refusal(c,id,name,args,expected) {
  const r=await call(c,name,args);
  record(id,r.isError && (expected instanceof RegExp?expected.test(r.text):r.text===expected),r,'Real stdio SDK refusal; no wallet settings supplied.');
}
const bare=await connect();
try {
  const tools=(await bare.listTools()).tools;
  const names=tools.map(t=>t.name).sort();
  record('MCP-001',JSON.stringify(names)===JSON.stringify(['auction_status','bid','complain','reveal','verify_result']) && tools.every(t=>t.inputSchema?.type==='object'),tools.map(({name,inputSchema})=>({name,inputSchema})),'Real initialization/listTools; built server uses StdioServerTransport.');
  const r=await Promise.all(['auction_status','verify_result'].map(n=>call(bare,n)));
  record('MCP-002',r.every(x=>x.isError && x.text==='Setup required: SBA_AUCTION_FILE'),r,'Both read-only tools refuse missing record setting.');
} finally {await bare.close();}
const missing=await connect('/nonexistent/fuin-audit-public-record.json');
try {
  const r=await Promise.all(['auction_status','verify_result'].map(n=>call(missing,n)));
  record('MCP-003',r.every(x=>x.isError && x.text==='Setup required: SBA_AUCTION_FILE (/nonexistent/fuin-audit-public-record.json does not exist)'),r,'Both read-only tools refuse nonexistent public file.');
} finally {await missing.close();}
const temp=mkdtempSync(resolve(tmpdir(),'fuin-readonly-mcp-'));
try {
  const fixture=resolve(temp,'no-outcome.json');
  writeFileSync(fixture,JSON.stringify({network:'testnet',auction:{name:'audit-synthetic-no-outcome'},deposits:[]}));
  const c=await connect(fixture);
  try {await refusal(c,'MCP-012','verify_result',{},'this auction has no published result yet');} finally {await c.close();}
} finally {rmSync(temp,{recursive:true,force:true});}
const sales=[
  {file:'deployments/testnet-sale003.json',name:'fuin-sale003-2026-10-22T21:24',status:'MCP-004',verify:'MCP-005',count:5,deposit:'200000',reserve:'50000',close:4530294,bid:'135000',winner:'dc95f63d12',unrevealed:1,high:'MCP-013',low:'MCP-014',highBid:140001,lowBid:49999},
  {file:'deployments/testnet-reveal.json',name:'fuin-reveal-2026-10-21T18:43',status:'MCP-006',verify:'MCP-007',count:9,deposit:'200000',reserve:'50000',close:4526455,bid:'135000',winner:'eb27d26d5b',unrevealed:1,high:'MCP-016',low:'MCP-017',highBid:140001,lowBid:49999},
  {file:'deployments/testnet.json',name:'sba-testnet-2026-10-20T13:30',status:'MCP-008',verify:'MCP-009',count:7,deposit:'2000000',reserve:'500000',close:4522278,bid:'1750000',winner:'d910ebad41',unrevealed:0,high:'MCP-019',low:'MCP-020',highBid:1940001,lowBid:499999},
];
for(const sale of sales) {
  const c=await connect(sale.file);
  try {
    const s=await call(c,'auction_status'); let status;
    try {status=JSON.parse(s.text);}catch{}
    const good=!s.isError && status && status.auction===sale.name && status.deposit_zat===sale.deposit && status.reserve_zat===sale.reserve && status.close_height===sale.close && status.deposits.length===sale.count && status.missing_from_published_record.length===0 && status.settlement_problems.length===0;
    record(sale.status,good,status??s,'Live scan of published closed sale via real stdio server; no wallet settings.');
    const r=await call(c,'verify_result');let v;
    try{v=JSON.parse(r.text);}catch{}
    const flags=['result_holds','settlement_mined_as_recorded','record_lists_every_chain_deposit','proof_verifies','auction_id_matches','slots_are_the_chain_deposits','winner_is_a_deposit'];
    const holds=!r.isError && v && flags.every(k=>v[k]===true) && v.winning_bid_zat===sale.bid && v.winner_deposit?.startsWith(sale.winner) && v.no_sale===null && v.unrevealed?.length===sale.unrevealed && v.failed?.length===0 && v.losing_bids_revealed===false;
    record(sale.verify,holds,v??r,'Live proof/deposit/winner/completeness assertions checked.');
    if(sale.status==='MCP-004') record('MCP-010',!r.isError && v?.no_sale===null && v?.deposits_after_the_record?.length===0,{deposits_after_the_record:v?.deposits_after_the_record,no_sale:v?.no_sale,error:r.isError?r.text:undefined},'Sale 003 scan boundary checked live.');
    await refusal(c,sale.high,'bid',{bid_zat:sale.highBid,refund_address:'utest1x'},`bid ${sale.highBid} zat is above the deposit (${sale.deposit}) minus the fee budget; nothing was sent`);
    await refusal(c,sale.low,'bid',{bid_zat:sale.lowBid,refund_address:'utest1x'},`bid ${sale.lowBid} zat is below the reserve ${sale.reserve}; nothing was sent`);
    if(sale.status==='MCP-004') {
      for(const [id,len] of [['MCP-022',151],['MCP-023',182],['MCP-024',217]])
        await refusal(c,id,'bid',{bid_zat:100000,refund_address:'utest1'+'q'.repeat(len-6)},`refund address is ${len} characters; a reveal holds at most 150 (an Orchard-only unified address fits, one with a Sapling or transparent receiver does not), so this deposit could never be revealed or refunded; nothing was sent`);
      const results=[];
      for(const args of [{bid_zat:0,refund_address:'utest1x'},{bid_zat:-1,refund_address:'utest1x'},{bid_zat:1.5,refund_address:'utest1x'},{bid_zat:'100000',refund_address:'utest1x'},{bid_zat:100000,refund_address:'invalid'}]) {
        const r=await call(c,'bid',args);results.push({...r,field:args.refund_address==='invalid'?'refund_address':'bid_zat'});
      }
      record('MCP-025',results.every(r=>r.isError && r.text.includes(r.field) && /validation|invalid/i.test(r.text)),results,'All five schema-invalid input cases refused before handler/wallet.');
    }
    if(sale.status==='MCP-008') {
      await refusal(c,'MCP-030','reveal',{},'this auction has no reveal channel (auction.revealKey and auction.revealCloseHeight are missing); nothing was sent');
      await refusal(c,'MCP-031','complain',{},'this auction has no reveal channel or dispute window; nothing was sent');
    }
  } finally {await c.close();}
}
for(const id of ['MCP-015','MCP-018','MCP-021','MCP-026','MCP-027','MCP-028','MCP-029','MCP-032','MCP-033','MCP-034','MCP-035'])
  record(id,false,{executed:false,reason:'Guard requires SBA_BIDDER_WALLET; hard rule forbids setting it, including disposable paths.'},'Requires prohibited SBA_BIDDER_WALLET setting before the specified refusal.','UNTESTED');
record('MCP-011',false,{executed:false,reason:'Existing full test file includes wallet configuration/send-attempt cases; no product/test source changed.'},'Full existing pnpm test not run because it attempts a wallet call and sets prohibited wallet configuration.','UNTESTED');
for(let i=36;i<=41;i++) record(`MCP-${String(i).padStart(3,'0')}`,false,{executed:false},'needs a funded Zcash testnet send; this audit must not send','UNTESTED');
