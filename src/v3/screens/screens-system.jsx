/* SECTION 08/09/10 — Tally, Cost Policy, Audit, Settings, Cmd+K, Mobile, States */

const Tally = () => (
  <Screen url="anvil.app/tally" active="Tally Masters" crumbs={["Anvil","Tally Masters"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">Tally masters</div>
      <Chip kind="good">● bridge online · 12ms</Chip><Chip>last sync 09:14</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm">Upload masters.xml</button>
      <button className="btn primary sm">Sync now</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
      {[["Stock items","4,312"],["Ledgers","318"],["GST classes","12"],["UOMs","9"],["Voucher types","6"]].map((s,i)=>(
        <div key={i} className="wf-card"><div className="h-eyebrow">{s[0]}</div><div style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:24,marginTop:4}}>{s[1]}</div><div className="mono-sm" style={{marginTop:2,color:"var(--good)"}}>✓ in sync</div></div>
      ))}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Voucher dry-run"/>
        <div style={{display:"flex",gap:10,marginBottom:10}}>
          <select className="select" style={{flex:1}}><option>SO-1042 · Tata Steel</option></select>
          <button className="btn">Run</button>
        </div>
        <pre style={{fontFamily:"var(--mono)",fontSize:10.5,background:"var(--paper-2)",border:"2px solid var(--rule)",padding:10,margin:0,whiteSpace:"pre-wrap",lineHeight:1.5,flex:1,overflow:"auto"}}>
{`POST /tally/voucher  201
✓ schema valid
✓ ledger exists: Tata Steel - JSR
✓ stock items: 18/18 mapped
✓ GST class: IGST 18%
⚠ narration > 200 chars · truncated
✓ committed as voucher V-9941`}
        </pre>
      </div>
      <div className="wf-card">
        <CardTitle title="Bridge config"/>
        <table className="tbl"><tbody>
          {[["URL","https://tally-mum.tail-…ts.ts.net"],["Token","tk_•••• rotated 14d"],["Latency p50","11 ms"],["Last error","—"],["Mode","dry-run + commit"]].map(([k,v])=><tr key={k}><td style={{color:"var(--ink-3)"}}>{k}</td><td className="mono">{v}</td></tr>)}
        </tbody></table>
        <button className="btn sm" style={{marginTop:10}}>Test bridge</button>
      </div>
    </div>
  </Screen>
);

const CostPolicy = () => (
  <Screen url="anvil.app/cost" active="Cost Policy" crumbs={["Anvil","Cost Policy"]}>
    <div className="h2">Cost policy & API usage</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
      {[["Spend MTD","₹ 1,184",""],["Saved by cache","₹ 740","good"],["Saved by reuse","₹ 312","good"],["Per-SO avg","₹ 4.20",""]].map((s,i)=>(
        <div key={i} className="wf-card"><div className="h-eyebrow">{s[0]}</div><div style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:28,marginTop:4}}>{s[1]}</div>{s[2]&&<Chip kind="good">↓ good</Chip>}</div>
      ))}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card">
        <CardTitle title="Policy"/>
        <label className="label">Mode</label>
        <div style={{display:"flex",gap:6,marginBottom:12}}>
          {["Realtime accuracy","Cost optimised","Batch candidate"].map((m,i)=>(
            <button key={m} className={"btn sm "+(i===1?"primary":"")} style={{flex:1}}>{m}</button>
          ))}
        </div>
        <label className="label">Prompt cache</label>
        <div style={{display:"flex",gap:6,marginBottom:12}}>
          {["Off","5 min","1 hour"].map((m,i)=>(<button key={m} className={"btn sm "+(i===1?"primary":"")} style={{flex:1}}>{m}</button>))}
        </div>
        <label className="label">Price-comp handling</label>
        <select className="select"><option>Warn before including</option></select>
        <div className="wf-divider" style={{margin:"14px 0"}}/>
        <div className="h-eyebrow">Pricing constants</div>
        <table className="tbl" style={{marginTop:6}}><tbody>
          {[["Input tokens","$3 / Mtok"],["Output tokens","$15 / Mtok"],["Cache write 5m","×1.25"],["Cache read","×0.10"],["FX (USD→INR)","83.40"]].map(([k,v])=><tr key={k}><td style={{color:"var(--ink-3)"}}>{k}</td><td><b>{v}</b></td></tr>)}
        </tbody></table>
      </div>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Spend over time" right={<><button className="btn sm">7d</button><button className="btn sm primary">30d</button><button className="btn sm">90d</button></>}/>
        <Bars data={[55,40,62,48,70,85,42,60,78,52,90,68,72,80,55,40,30,55,68,72]} accentAt={11}/>
        <div className="wf-divider" style={{margin:"14px 0"}}/>
        <CardTitle title="Recent calls"/>
        <table className="tbl">
          <thead><tr><th>SO</th><th>Stage</th><th>In</th><th>Out</th><th>Cache rd</th><th>Cost</th></tr></thead>
          <tbody>
            {[["SO-1042","extract",4210,1080,3610,"₹0.78"],["SO-1041","preflight",2010,440,1820,"₹0.32"],["SO-1040","extract",3940,920,3560,"₹0.71"],["SO-1039","extract",6210,1410,0,"₹2.41"]].map((r,i)=>(
              <tr key={i}><td><b>{r[0]}</b></td><td className="mono">{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td><td>{r[4]}</td><td><b>{r[5]}</b></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </Screen>
);

const AuditLog = () => (
  <Screen url="anvil.app/audit" active="Audit Log" crumbs={["Anvil","Audit Log"]}>
    <div style={{display:"flex",gap:10,alignItems:"center"}}>
      <div className="h2">Audit log</div><Chip>append-only</Chip><Chip>14,228 events</Chip>
      <div style={{flex:1}}/>
      <input className="input" placeholder="case_id, user, event…" style={{width:280}}/>
      <button className="btn sm">Export NDJSON</button>
    </div>
    <div className="wf-card" style={{flex:1,padding:0,overflow:"hidden"}}>
      <table className="tbl">
        <thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Case</th><th>Field / target</th><th>Before</th><th>After</th><th>Source</th></tr></thead>
        <tbody>
          {[
            ["10:42:04","KP","tally.committed","SO-1042","voucher","—","V-9941","bridge"],
            ["10:42:01","KP","approval.granted","SO-1042","status","draft","approved","ui"],
            ["10:38:22","KP","field.override","SO-1042","line[6].rate","1840.00","1840.00 (intentional)","ui"],
            ["10:36:11","auto","anomaly.detected","SO-1042","line[6].rate","—","10× median","engine"],
            ["10:35:02","auto","extraction.completed","SO-1042","18 lines","—","—","claude"],
            ["10:34:18","auto","preflight.passed","SO-1042","fingerprint","—","ok","engine"],
            ["10:34:01","KP","document.uploaded","SO-1042","po-tata-2456.pdf","—","—","email"],
            ["09:14:00","auto","tally.sync","masters","items","4,308","4,312","cron"],
            ["09:12:44","RM","alias.created","—","'OIL-SEAL-25x42x7'","—","OS-25-42-7","ui"],
          ].map((r,i)=>(
            <tr key={i}><td>{r[0]}</td><td><b>{r[1]}</b></td><td className="mono" style={{color:"var(--accent)"}}>{r[2]}</td>
              <td>{r[3]}</td><td>{r[4]}</td><td style={{color:"var(--ink-3)"}}>{r[5]}</td><td><b>{r[6]}</b></td><td className="mono-sm">{r[7]}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </Screen>
);

const Settings = () => (
  <Screen url="anvil.app/settings/team" active="Settings" crumbs={["Anvil","Settings","Team"]}>
    <div style={{display:"flex",gap:10}}>
      {["Team","Tenant","Integrations","Email-in","Notifications","Billing","API keys","Danger"].map((t,i)=>(
        <button key={t} className={"btn sm "+(i===0?"primary":"")}>{t}</button>
      ))}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card">
        <CardTitle title="Members · 12" right={<button className="btn sm primary">+ Invite</button>}/>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last seen</th><th></th></tr></thead>
          <tbody>
            {[
              ["K. Philip","kenith@obara.in","sales-engineer","now"],
              ["R. Mehra","rahul@obara.in","manager","12m"],
              ["S. Mehta","sachin@obara.in","procurement","2h"],
              ["A. Singh","ashok@obara.in","finance","1d"],
              ["P. Rao","priya@obara.in","admin","3h"],
              ["External · auditor","ext-aud@kpmg.in","viewer","never"],
            ].map((r,i)=>(
              <tr key={i}><td><b>{r[0]}</b></td><td className="mono-sm">{r[1]}</td>
                <td><Chip kind={r[2]==="admin"?"accent":r[2]==="viewer"?"":r[2]==="manager"?"fill":""}>{r[2]}</Chip></td>
                <td>{r[3]}</td><td><button className="btn sm">⋯</button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="wf-card">
        <CardTitle title="Role matrix"/>
        <table className="tbl">
          <thead><tr><th>Action</th><th>SE</th><th>Mgr</th><th>Pro</th><th>Fin</th><th>Adm</th><th>View</th></tr></thead>
          <tbody>
            {[
              ["Create SO","✓","✓","","","✓",""],
              ["Approve SO","","✓","","","✓",""],
              ["Push Tally","","✓","","✓","✓",""],
              ["Edit masters","","","","","✓",""],
              ["View costs","","✓","","✓","✓",""],
              ["View audit","✓","✓","✓","✓","✓","✓"],
              ["Delete records","","","","","✓",""],
            ].map((r,i)=>(
              <tr key={i}><td><b>{r[0]}</b></td>
                {r.slice(1).map((c,j)=><td key={j} style={{textAlign:"center",color:c?"var(--good)":"var(--ink-4)"}}>{c||"·"}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </Screen>
);

const CmdK = () => (
  <Screen url="anvil.app/overview" active="Overview" crumbs={["Anvil","Overview"]}>
    <div style={{flex:1,position:"relative"}}>
      <div style={{position:"absolute",inset:0,background:"rgba(14,14,12,0.55)"}}/>
      <div style={{position:"absolute",top:60,left:"50%",transform:"translateX(-50%)",width:560,background:"var(--paper)",border:"3px solid var(--rule)",boxShadow:"8px 8px 0 var(--rule)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",borderBottom:"2px solid var(--rule)"}}>
          <span style={{fontFamily:"var(--mono)",fontSize:16}}>⌕</span>
          <input className="input" style={{border:"none",padding:0,fontSize:15}} defaultValue="tata"/>
          <Kbd>esc</Kbd>
        </div>
        <div className="mono-sm" style={{padding:"8px 16px",color:"var(--ink-3)"}}>RESULTS · 7</div>
        {[
          ["customer","Tata Steel · Jamshedpur","112 orders · extractor-ready","↵"],
          ["order","SO-1042 · Tata Steel","12m ago · extracted","↵"],
          ["alias","BR-6204-ZZ ← BRG-6204-2RS","98% conf","↵"],
          ["action","Sync Tally masters","cmd","⌘⏎"],
          ["action","Connect backend","cmd",""],
          ["action","Open integration report","cmd",""],
          ["action","Toggle cost policy","cmd",""],
        ].map((r,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px",borderBottom:"1px solid var(--hairline)",background:i===0?"var(--paper-2)":""}}>
            <Chip>{r[0]}</Chip>
            <div style={{flex:1}}>
              <div style={{fontFamily:"var(--sans)",fontWeight:700}}>{r[1]}</div>
              <div className="mono-sm">{r[2]}</div>
            </div>
            <span className="mono-sm">{r[3]}</span>
          </div>
        ))}
        <div style={{padding:"8px 16px",borderTop:"2px solid var(--rule)",display:"flex",gap:14,fontFamily:"var(--mono)",fontSize:11,color:"var(--ink-3)"}}>
          <span><Kbd>↑↓</Kbd> navigate</span><span><Kbd>↵</Kbd> open</span><span><Kbd>⌘↵</Kbd> run</span><span style={{flex:1}}/><span>cmd palette</span>
        </div>
      </div>
    </div>
  </Screen>
);

/* MOBILE COMPANION */

const MQueue = () => (
  <Phone>
    <div style={{padding:"6px 14px 8px",borderBottom:"2px solid var(--rule)",display:"flex",alignItems:"center",gap:8}}>
      <div style={{width:18,height:18,background:"var(--ink)",position:"relative"}}><div style={{position:"absolute",left:"50%",top:"50%",width:7,height:7,background:"var(--accent)",transform:"translate(-50%,-50%) rotate(45deg)"}}/></div>
      <div style={{fontWeight:900,letterSpacing:"0.06em",fontSize:13,textTransform:"uppercase"}}>Anvil</div>
      <div style={{flex:1}}/>
      <Chip kind="warn">3 to do</Chip>
    </div>
    <div style={{padding:14}}>
      <div className="h-eyebrow">Today</div>
      <div className="h2" style={{fontSize:18,marginTop:4}}>Approvals queue</div>
    </div>
    <div style={{flex:1,padding:"0 12px 12px",display:"flex",flexDirection:"column",gap:8,overflow:"auto"}}>
      {[
        ["SO-1038","Cummins India","₹ 18.8L","manager signoff","accent"],
        ["SO-1042","Tata Steel","₹ 6.2L","2 anomalies",""],
        ["SO-1040","Bosch","₹ 4.4L","ready to push","good"],
      ].map((r,i)=>(
        <div key={i} className="wf-box" style={{padding:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
            <div><b>{r[0]}</b> <span className="mono-sm">· {r[1]}</span></div>
            <Chip kind={r[4]}>{r[3]}</Chip>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:8,alignItems:"center"}}>
            <span style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:18}}>{r[2]}</span>
            <button className="btn sm primary">Open →</button>
          </div>
        </div>
      ))}
    </div>
    <div style={{borderTop:"2px solid var(--rule)",display:"flex"}}>
      {["Queue","Capture","Findings","Me"].map((t,i)=>(
        <div key={t} style={{flex:1,padding:"10px 0",textAlign:"center",fontFamily:"var(--mono)",fontSize:10,textTransform:"uppercase",borderRight:i<3?"2px solid var(--rule)":"",background:i===0?"var(--ink)":"",color:i===0?"var(--paper)":""}}>{t}</div>
      ))}
    </div>
  </Phone>
);

const MCapture = () => (
  <Phone>
    <div style={{padding:"6px 14px 8px",borderBottom:"2px solid var(--rule)",display:"flex",alignItems:"center",gap:8}}>
      <span className="mono">‹</span>
      <div style={{flex:1,fontWeight:800,fontSize:13}}>Capture PO</div>
      <Chip>step 1/3</Chip>
    </div>
    <div style={{padding:14,display:"flex",flexDirection:"column",gap:10,flex:1}}>
      <div className="wf-card" style={{padding:0,overflow:"hidden"}}>
        <Ph label="camera viewfinder" h={300}/>
      </div>
      <div className="mono-sm" style={{textAlign:"center"}}>Hold steady · auto-capture in 0.4s</div>
      <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"center"}}>
        <button className="btn sm">Gallery</button>
        <div style={{width:54,height:54,borderRadius:999,border:"3px solid var(--rule)",background:"var(--accent)"}}/>
        <button className="btn sm">Email-in</button>
      </div>
    </div>
  </Phone>
);

const MOrder = () => (
  <Phone>
    <div style={{padding:"6px 14px 8px",borderBottom:"2px solid var(--rule)",display:"flex",alignItems:"center",gap:8}}>
      <span className="mono">‹</span><div style={{flex:1,fontWeight:800,fontSize:13}}>SO-1038</div><span className="mono">⋯</span>
    </div>
    <div style={{padding:14,flex:1,overflow:"auto",display:"flex",flexDirection:"column",gap:10}}>
      <div>
        <div className="h-eyebrow">Cummins India · Pune</div>
        <div className="h1" style={{fontSize:24,marginTop:4}}>₹ 18,84,200</div>
        <div className="mono-sm">6 lines · drafted · ETA 14-May</div>
      </div>
      <Chip kind="accent">★ manager signoff needed</Chip>
      <div className="wf-card">
        <CardTitle title="Top lines"/>
        {[["BR-6204-ZZ","100 NOS","₹ 18,400"],["UCFL-204","40 NOS","₹ 24,480"],["+ 4 more","","→"]].map((r,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:i<2?"1px solid var(--hairline)":"",fontFamily:"var(--mono)",fontSize:11.5}}>
            <span><b>{r[0]}</b></span><span>{r[1]}</span><span><b>{r[2]}</b></span>
          </div>
        ))}
      </div>
      <div className="wf-card">
        <CardTitle title="Checks"/>
        <div style={{fontFamily:"var(--mono)",fontSize:11.5,lineHeight:1.8}}>
          <div style={{color:"var(--good)"}}>✓ Credit OK (₹4.2L of ₹50L)</div>
          <div style={{color:"var(--good)"}}>✓ Margin 10.2%</div>
          <div style={{color:"var(--warn)"}}>⚠ 1 component low stock (UCFL-204)</div>
        </div>
      </div>
    </div>
    <div style={{borderTop:"2px solid var(--rule)",padding:10,display:"flex",gap:8}}>
      <button className="btn" style={{flex:1}}>Send back</button>
      <button className="btn primary" style={{flex:1.4}}>Approve</button>
    </div>
  </Phone>
);

const MAuth = () => (
  <Phone>
    <div style={{flex:1,padding:24,display:"flex",flexDirection:"column",justifyContent:"center"}}>
      <div style={{width:32,height:32,background:"var(--ink)",position:"relative",marginBottom:18}}><div style={{position:"absolute",left:"50%",top:"50%",width:13,height:13,background:"var(--accent)",transform:"translate(-50%,-50%) rotate(45deg)"}}/></div>
      <div className="h1" style={{fontSize:30,lineHeight:1}}>Sales ops, with receipts.</div>
      <div className="body" style={{marginTop:10}}>Magic-link sign in · no passwords.</div>
      <label className="label" style={{marginTop:18}}>Work email</label>
      <input className="input" defaultValue="kenith@obara.in"/>
      <button className="btn primary" style={{marginTop:14,justifyContent:"center"}}>Send link →</button>
      <div className="mono-sm" style={{marginTop:24,textAlign:"center"}}>Need help? <u>Contact admin</u></div>
    </div>
  </Phone>
);

/* STATES — empty + error */

const EmptyOrders = () => (
  <Screen url="anvil.app/orders" active="Sales Orders" crumbs={["Anvil","Sales Orders"]}>
    <div className="h2">Sales Orders</div>
    <div className="wf-card" style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,textAlign:"center"}}>
      <div style={{fontFamily:"var(--mono)",fontSize:64,lineHeight:1,color:"var(--ink-4)"}}>∅</div>
      <div className="h2">No orders yet</div>
      <div className="body" style={{maxWidth:380}}>Drop a customer PO to create your first order. We'll preflight it, extract line items, and prep a Tally voucher — all with provenance.</div>
      <div style={{display:"flex",gap:8,marginTop:6}}>
        <button className="btn primary">+ Capture PO</button>
        <button className="btn">Forward to email-in</button>
        <button className="btn ghost">Load demo data</button>
      </div>
      <div className="mono-sm" style={{marginTop:30,color:"var(--ink-4)",borderTop:"1px solid var(--hairline)",paddingTop:14,width:380}}>
        Tip: press ⌘K to open the command palette
      </div>
    </div>
  </Screen>
);

const SystemError = () => (
  <Screen url="anvil.app/overview" active="Overview" crumbs={["Anvil","Overview"]}>
    <div className="wf-card" style={{borderWidth:3,borderColor:"var(--bad)",padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:54,height:54,background:"var(--bad)",color:"var(--paper)",display:"grid",placeItems:"center",fontFamily:"var(--mono)",fontSize:28}}>×</div>
        <div style={{flex:1}}>
          <div className="h-eyebrow" style={{color:"var(--bad)"}}>System · degraded</div>
          <div className="h2" style={{marginTop:4}}>Tally bridge unreachable since 09:14</div>
          <div className="mono-sm">Outbound vouchers will queue until the bridge recovers. SO creation and extraction continue normally.</div>
        </div>
        <button className="btn sm">Retry now</button>
        <button className="btn primary sm">Open status</button>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
      {[["Queued vouchers","3","oldest 08:42"],["Backend latency","42 ms p50","ok"],["Anthropic API","✓ ok","12ms"]].map((s,i)=>(
        <div key={i} className="wf-card"><div className="h-eyebrow">{s[0]}</div><div style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:24,marginTop:4}}>{s[1]}</div><div className="mono-sm" style={{marginTop:2}}>{s[2]}</div></div>
      ))}
    </div>
    <div className="wf-card" style={{flex:1}}>
      <CardTitle title="Recent attempts"/>
      <pre style={{fontFamily:"var(--mono)",fontSize:11,margin:0,whiteSpace:"pre-wrap",lineHeight:1.6,color:"var(--ink-3)"}}>
{`09:14:02  bridge.health  → ECONNREFUSED  retry in 30s
09:14:32  bridge.health  → ECONNREFUSED  retry in 60s
09:15:32  bridge.health  → ECONNREFUSED  retry in 120s
09:17:32  bridge.health  → timeout       retry in 240s`}
      </pre>
    </div>
  </Screen>
);

const OfflineMode = () => (
  <Screen url="anvil.app/orders" active="Sales Orders" crumbs={["Anvil","Sales Orders"]} dark>
    <div className="wf-card" style={{borderColor:"var(--accent)",borderWidth:3,padding:14,display:"flex",alignItems:"center",gap:14}}>
      <Chip kind="accent">● offline</Chip>
      <div style={{flex:1}}>
        <div style={{fontFamily:"var(--sans)",fontWeight:700}}>You're working from local storage</div>
        <div className="mono-sm">Captured POs queue locally and sync when the backend is reachable. No API calls until reconnected.</div>
      </div>
      <button className="btn sm primary">Reconnect</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
      {[["Queued uploads","2"],["Local drafts","5"],["Pending audit","18"]].map((s,i)=>(
        <div key={i} className="wf-card"><div className="h-eyebrow">{s[0]}</div><div style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:24,marginTop:4}}>{s[1]}</div></div>
      ))}
    </div>
  </Screen>
);

Object.assign(window, { Tally, CostPolicy, AuditLog, Settings, CmdK, MQueue, MCapture, MOrder, MAuth, EmptyOrders, SystemError, OfflineMode });
