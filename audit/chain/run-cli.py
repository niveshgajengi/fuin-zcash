"""Read-only CLI audit; never reads deployment records or wallet material itself."""
from pathlib import Path
import concurrent.futures, json, os, re, shutil, signal, socket, subprocess, tempfile, time

ROOT = Path.cwd()
OUT = ROOT / 'audit/chain'
ENV = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME') if k in os.environ}
ROWS = []

def scrub(s):
    return re.sub(r'(?:uivk|ufvk|uview|uviews|utest1|secret-extended-key|zxviews)[a-z0-9]{20,}', '[REDACTED]', s, flags=re.I)

def run(args, extra=None, cwd=ROOT, timeout=700):
    try:
        p = subprocess.run(args, cwd=cwd, env={**ENV, **(extra or {})}, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        return 124, '', f'timeout after {timeout}s'

def save(name, text):
    path = OUT / (name + '.txt')
    path.write_text(scrub(text))
    return str(path.relative_to(ROOT))

def add(ident, passed, evidence, note, untested=False):
    ROWS.append(dict(id=ident, status='UNTESTED' if untested else ('PASS' if passed else 'FAIL'), evidence=evidence, note=scrub(note)))
    (OUT / 'cli-results.json').write_text(json.dumps(ROWS, indent=2) + '\n')
    print(ident, ROWS[-1]['status'], scrub(note), flush=True)

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def check_site():
    code, out, err = run(['pnpm', 'build:site'])
    expected = ['index.html','evidence.html','assets/hero.webp','saleroom/index.html','saleroom/verification_key.json','.nojekyll']
    files = all((ROOT/'site'/p).is_file() and ((ROOT/'site'/p).stat().st_size > 0 or p == '.nojekyll') for p in expected)
    assets = list((ROOT/'site/saleroom/assets').glob('*.js')) and list((ROOT/'site/saleroom/assets').glob('*.css'))
    links = all('href="saleroom/"' in (ROOT/'site'/p).read_text() for p in ['index.html','evidence.html'])
    evidence = save('CLI-001', f'pnpm build:site exit={code}\nrequired files={files}; JS/CSS assets={bool(assets)}; relative saleroom links={links}\n'+out[-2500:]+err)
    add('CLI-001', code == 0 and files and assets and links, evidence, 'Built static artifact and checked required files and relative links.')

    p = port()
    code, out, err = run(['bash','e2e/stack.sh'], {'FUIN_PORT':str(p)})
    pidfile = ROOT/'e2e/.run/pids'
    pid = None
    ok = code == 0 and pidfile.is_file()
    detail = f'free FUIN_PORT={p}; start exit={code}\n'+out+err
    if ok:
        lines = pidfile.read_text().splitlines()
        ok = len(lines) == 1 and lines[0].split()[0] == 'site'
        pid = int(lines[0].split()[1])
        for route in ['/', '/saleroom/', '/saleroom/verification_key.json']:
            c, status, error = run(['curl','-sS','--max-time','10','-o','/dev/null','-w','%{http_code}',f'http://127.0.0.1:{p}{route}'])
            ok = ok and c == 0 and status == '200'
            detail += f'GET {route}: {status}; exit={c}\n'
    c, out, err = run(['bash','e2e/stack.sh','stop'])
    detail += f'stop exit={c}\n'+out+err
    time.sleep(.2)
    try:
        if pid: os.kill(pid, 0); stopped = False
        else: stopped = False
    except ProcessLookupError:
        stopped = True
    detail += f'recorded server PID terminated={stopped}; pid file removed={not pidfile.exists()}\n'

    # Fault injection uses an unchanged copy of stack.sh with an isolated build script.
    with tempfile.TemporaryDirectory(prefix='fuin-stack-audit-') as temp:
        base=Path(temp); (base/'e2e').mkdir(); (base/'scripts').mkdir()
        shutil.copyfile(ROOT/'e2e/stack.sh',base/'e2e/stack.sh')
        build=base/'scripts/build-site.sh'; build.write_text('#!/bin/bash\nexit 17\n'); build.chmod(0o755)
        c, out, err = run(['bash','e2e/stack.sh'], {'FUIN_PORT':str(port())}, cwd=base)
        build_failure=c != 0 and 'site build failed' in err and not (base/'e2e/.run/pids').exists()
        detail += f'isolated build failure exit={c}; no server PID={build_failure}\n'+out+err
    with tempfile.TemporaryDirectory(prefix='fuin-readiness-audit-') as temp:
        base=Path(temp); (base/'e2e').mkdir(); (base/'scripts').mkdir(); (base/'bin').mkdir(); (base/'site').mkdir()
        shutil.copyfile(ROOT/'e2e/stack.sh',base/'e2e/stack.sh')
        build=base/'scripts/build-site.sh'; build.write_text('#!/bin/bash\nexit 0\n'); build.chmod(0o755)
        for name,body in [('curl','exit 22'),('sleep','exit 0')]:
            shim=base/'bin'/name; shim.write_text('#!/bin/sh\n'+body+'\n'); shim.chmod(0o755)
        with socket.socket() as unrelated:
            unrelated.bind(('127.0.0.1',0)); unrelated.listen(); unrelated_port=unrelated.getsockname()[1]
            c,out,err=run(['bash','e2e/stack.sh'],{'FUIN_PORT':str(port()),'PATH':str(base/'bin')+':'+ENV['PATH']},cwd=base)
            match=re.search(r'stopped site \((\d+)\)',out)
            terminated=False
            if match:
                try: os.kill(int(match.group(1)),0)
                except ProcessLookupError: terminated=True
            preserved=unrelated.getsockname()[1]==unrelated_port
            readiness_failure=c != 0 and 'not up:' in err and not (base/'e2e/.run/pids').exists() and terminated and preserved
            detail+=f'isolated readiness failure exit={c}; own server terminated={terminated}; unrelated listener alive={preserved}; PID file removed={not (base/"e2e/.run/pids").exists()}\n'+out+err
    evidence=save('CLI-002',detail)
    add('CLI-002',ok and stopped and build_failure and readiness_failure,evidence,'Free-port lifecycle, PID ownership/termination, isolated build/readiness failure cleanup and unrelated listener preservation checked.')

    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0)); listener.listen(); p=listener.getsockname()[1]
        c,out,err=run(['bash','e2e/stack.sh'],{'FUIN_PORT':str(p)})
        alive=listener.getsockname()[1]==p
        expected=f'port {p} is already in use by another process; set FUIN_PORT to a free port'
        evidence=save('CLI-003',f'occupied FUIN_PORT={p}; exit={c}; existing listener alive={alive}\n'+out+err)
        add('CLI-003',c != 0 and expected in err and alive,evidence,'Occupied port refused; existing listener stayed alive.')
    detail=''; ok=True
    for value in ['abc','1023','4190','5060','5061','6000','6566',*map(str,range(6665,6670)),'6697','10080']:
        c,out,err=run(['bash','e2e/stack.sh'],{'FUIN_PORT':value})
        expected='FUIN_PORT must be a number from 1024 up' if value in ['abc','1023'] else "one browsers and Node's fetch block"
        ok=ok and c != 0 and expected in err
        detail+=f'FUIN_PORT={value}; exit={c}\n'+out+err
    evidence=save('CLI-004',detail)
    add('CLI-004',ok,evidence,'Nonnumeric, below-1024, and every listed blocked port refused before any server start.')

def verifier():
    binary=str(ROOT/'packages/verifier/target/release/sba-verify')
    for ident,args in [('CLI-005',['tip']),('CLI-006',['block','4530332']),('CLI-007',['block','invalid']),('CLI-008',[])]:
        code,out,err=run([binary,*args],timeout=65)
        ok=False
        if ident=='CLI-005': ok=code==0 and out.strip().isdigit() and int(out.strip())>=4530338
        if ident=='CLI-006':
            try:
                r=json.loads(out); ok=code==0 and r['height']==4530332 and r['time']==1792705940 and bool(re.fullmatch('[0-9a-fA-F]{64}',r['hash']))
            except (ValueError,KeyError): pass
        if ident=='CLI-007': ok=code==1 and err.strip()=='error: bad height invalid' and not out.strip()
        if ident=='CLI-008': ok=code==1 and all(x in out+err for x in ['tx','scan','owns','tip','block','derive']) and 'all checks pass' not in out+err
        evidence=save(ident,f'sba-verify {" ".join(args)}\nexit={code}\nstdout:\n{out}\nstderr:\n{err}')
        add(ident,ok,evidence,err.strip() if code and ident in ['CLI-005','CLI-006'] else f'exit={code}; expected output checked')

def audit_sale(record,complaint,ids):
    args=['pnpm','--filter','@sba/service','run','audit',record]+([complaint] if complaint else [])
    code,out,err=run(args)
    lines=[l for l in out.splitlines() if l.strip()]
    terms=next((l for l in lines if re.match(r'^[✓✗!] terms:',l)), '(terms line absent)')
    last=lines[-1] if lines else '(no stdout)'
    errors=[l.strip() for l in err.splitlines() if l.startswith('Error:') or l.startswith('error:') or 'Setup required:' in l and not 'throw new' in l]
    failure='; '.join(errors) or f'exit={code}; last={last}'
    # Persist only terms and last audit line, plus boolean assertions and sanitized errors.
    log='command: '+' '.join(args)+f'\nexit={code}\nterms: {terms}\nlast nonempty stdout: {last}\n'
    if errors: log+='error: '+failure+'\n'
    checks={}
    for ident in ids:
        ok=code==0
        if ident=='CLI-011': ok=ok and '✓ terms: the auction id is the hash of every term' in out and '! terms: legacy' not in out and all(x in terms for x in ['name','address','uivk','depositZat','reserveZat','openHeight','closeHeight','revealCloseHeight','disputeBlocks','revealKey','seller'])
        if ident=='CLI-012': ok=ok and all(x in out for x in ['mined at block 4530332, as the record says','blocks 4530264-4530332','up to 4530327','block 4530318','5 of their payments are deposits','duplicate','is unrevealed','5 reveal note(s) on chain, 5 in the record'])
        if ident=='CLI-013': ok=ok and all(x in out for x in ['✓ proof: the Groth16 proof verifies with the MaxBid verification key','✓ auction: proof is for auction','✓ slots: slots 0-2 are the 3 revealed valid deposits in chain order; slots 3-7 are empty','✓ winner: slot 1 is deposit dc95f63d12','135000 zat','winner: deposit dc95f63d12','only an Ironwood bundle','auction key sees no outputs']) and '✗' not in out
        if ident=='CLI-014': ok=ok and all(x in out for x in ['unfounded: reveal 6e9e9cf97c (block 4530306) was honoured; payment not checked: the complaint gives no refund viewing key','dispute window 4530333-4530392'])
        if ident in ['CLI-015','CLI-019']: ok=ok and last=='chain checks pass; payments not checked'
        if ident=='CLI-016': ok=ok and all(x in out for x in ['! terms: legacy','mined at block 4526493','9 of their payments are deposits','5 reveal note(s) on chain, 5 in the record'])
        if ident=='CLI-017': ok=ok and all(x in out for x in ['unfounded: reveal 07ec9dcd08 (block 4526464) was honoured','paid in full: the refund address received 5000 zat in settlement e84de386e2, owed 5000']) and last=="chain checks pass; payments partly checked: the complaints' refunds were checked, the seller's payout needs the seller's incoming viewing key (SBA_SELLER_UIVK)"
        if ident=='CLI-018': ok=ok and all(x in out for x in ['! terms: legacy','blocks 4522258-4522291','7 transaction(s) pay the auction','predates the reveal channel','winner: deposit d910ebad41, winning bid 1750000 zat','only an Ironwood bundle'])
        checks[ident]=ok
        log+=f'{ident} expected assertions: {"PASS" if ok else "FAIL"}\n'
    evidence=save('audit-'+Path(record).stem,log)
    for ident,ok in checks.items():
        note=failure if code else ('Exact required final line differs from actual final line.' if not ok and ident in ['CLI-015','CLI-019'] else 'Live public audit assertions checked; only terms/final line retained.')
        add(ident,ok,evidence,note)

def negative_audits():
    for ident,extra,needle in [('CLI-009',{'SBA_VERIFY_BIN':'/nonexistent/sba-verify'},'Setup required: SBA_VERIFY_BIN'),('CLI-020',{'SBA_LWD_URL':'http://127.0.0.1:1'},'sba-verify failed:')]:
        code,out,err=run(['pnpm','--filter','@sba/service','run','audit','deployments/testnet-sale003.json'],extra,timeout=70)
        terms=next((l for l in out.splitlines() if re.match(r'^[✓✗!] terms:',l)), '(absent)')
        errors=[l for l in err.splitlines() if l.startswith('Error:') or l.startswith('error:')]
        evidence=save(ident,f'exit={code}\n{terms}\n'+'\n'.join(errors)+'\n')
        add(ident,code!=0 and needle in err and 'chain checks pass' not in out and 'all checks pass' not in out,evidence,'; '.join(errors))

if __name__=='__main__':
    check_site()
    verifier()
    negative_audits()
    audit_sale('deployments/testnet-sale003.json','deployments/complaints/131728459360241149736859342020074215002-6e9e9cf97c662997b116e7cb20c9709f14433bea8591ab4d3c8659f46f1f7f5a.complaint.json',[f'CLI-{i:03}' for i in range(10,16)])
    audit_sale('deployments/testnet-reveal.json','deployments/complaints/2582488456264710777-07ec9dcd0814d5557ebf72932e1e4931c8ea944b5a8e87a641c2df45062d5553.complaint.json',['CLI-016','CLI-017'])
    audit_sale('deployments/testnet.json',None,['CLI-018','CLI-019'])
