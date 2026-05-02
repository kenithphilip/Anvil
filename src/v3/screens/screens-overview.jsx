/* SECTION 02 — Ops Overview · 3 directions
   A = Operator triage (recommended)
   B = Exec scorecard
   C = Pipeline kanban
*/

/* ─────────────────────────────────────────────────────────
   A · Operator triage — the screen the team lives in
   ───────────────────────────────────────────────────────── */
const DashA = () => (
  <Screen url="overview"
    active="Overview" crumbs={["Ops","Overview"]}
    topRight={<>
      <button className="btn sm ghost"><Ic name="refresh" size={11}/>Sync</button>
      <button className="btn sm primary"><Ic name="plus" size={11}/>Capture PO</button>
    </>}>

    {/* Greeting strip */}
    <div style={{display:"flex",alignItems:"baseline",gap:16}}>
      <div className="h-eyebrow">Fri · 02 May · 09:14 IST</div>
      <div className="h1" style={{fontSize:26}}>Good morning, Kenith.</div>
      <div className="mono-sm" style={{flex:1}}>14 in queue · 3 blocked · 2 awaiting your approval</div>
      <Chip kind="good"><Dot kind="good"/>backend healthy</Chip>
      <Chip kind="warn"><Dot kind="warn"/>tally bridge: 1 retry</Chip>
    </div>

    {/* KPI strip */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:0,border:"1px solid var(--ink)"}}>
      {[
        ["IN YOUR QUEUE", "14", "+4 since 08:00", ""],
        ["OPEN SO VALUE", "₹38.4L", "↑ 12% w/w", ""],
        ["AWAITING APPROVAL", "3", "2 high-value", "bad"],
        ["FIRST-PASS ACC.", "92%", "↑ 3pp · 30d", ""],
        ["API SPEND · MTD", "₹1,184", "38% saved by cache", "live"],
      ].map(([l,v,d,k],i) => (
        <div key={l} style={{padding:"14px 16px", borderRight:i<4?"1px solid var(--ink)":"none", background: k==="live"?"var(--accent)":"var(--paper)", position:"relative"}}>
          <div className="h-eyebrow" style={{fontSize:9}}>{l}</div>
          <div className="num" style={{fontSize:30, lineHeight:1, marginTop:6, fontWeight:700}}>{v}</div>
          <div className={"delta " + (k==="bad"?"bad":"")} style={{marginTop:5, fontFamily:"var(--mono)",fontSize:10.5}}>{d}</div>
          {i===4 && <div className="mono-sm" style={{position:"absolute",bottom:6,right:8,fontSize:9}}>$ 14.06</div>}
        </div>
      ))}
    </div>

    {/* Main split */}
    <div style={{display:"grid",gridTemplateColumns:"1.7fr 1fr",gap:12,flex:1,minHeight:0}}>
      {/* Triage queue */}
      <div className="wf-card" style={{display:"flex",flexDirection:"column",minHeight:0,padding:0}}>
        <div style={{padding:"12px 16px", borderBottom:"1px solid var(--ink)", display:"flex",alignItems:"center",gap:10}}>
          <div className="h3">Triage queue</div>
          <Chip kind="ghost">14 items</Chip>
          <div style={{flex:1}}/>
          <div style={{display:"flex",gap:6,fontFamily:"var(--mono)",fontSize:10.5}}>
            <button className="btn sm" style={{background:"var(--ink)",color:"var(--paper)"}}>Mine</button>
            <button className="btn sm ghost">Team</button>
            <button className="btn sm ghost">All</button>
          </div>
          <button className="btn sm ghost">Sort: next-action ▾</button>
        </div>
        <div style={{flex:1,overflow:"hidden"}}>
          <table className="tbl">
            <thead><tr>
              <th style={{width:24}}></th>
              <th>PO #</th><th>Customer</th><th>State</th>
              <th>Next action</th><th style={{textAlign:"right"}}>Conf</th>
              <th style={{textAlign:"right"}}>Value</th><th>Age</th>
            </tr></thead>
            <tbody>
              {[
                ["live", "PO-2456","Tata Steel · Jamshedpur","extracted","Review 2 anomalies","0.94","₹6,21,400","12m"],
                ["bad",  "PO-2455","Mahindra · Nashik","blocked","Resolve duplicate vs PO-2451","—","₹2,14,800","1h"],
                ["",     "PO-2454","Bosch · Bangalore","validated","Push to Tally","0.98","₹4,40,000","2h"],
                ["warn", "PO-2451","L&T Heavy · Powai","preflight","Map 1 unknown part (HX-220)","0.82","₹11,02,600","3h"],
                ["",     "PO-2447","Cummins · Pune","drafted","Manager approval","0.96","₹18,80,000","1d"],
                ["",     "PO-2444","JCB India · Ballabgarh","extracted","Confirm 3 price comparables","0.89","₹1,84,100","1d"],
                ["",     "PO-2440","Ashok Leyland","ocr","Re-run extraction (page 3)","0.71","₹3,12,000","1d"],
                ["",     "PO-2438","Bharat Forge","drafted","Send confirmation to buyer","0.97","₹7,96,400","2d"],
              ].map((r,i) => (
                <tr key={i} className={r[0]==="live"?"row-live":r[0]==="bad"?"row-flag":r[0]==="warn"?"row-warn":""}>
                  <td><Dot kind={r[0]||"muted"}/></td>
                  <td><span className="pri">{r[1]}</span></td>
                  <td>{r[2]}</td>
                  <td><Chip kind={r[3]==="blocked"?"bad":r[3]==="validated"?"good":r[3]==="preflight"||r[3]==="ocr"?"warn":r[3]==="extracted"?"":""}>{r[3]}</Chip></td>
                  <td style={{fontWeight:600,color:r[0]==="live"?"var(--ink)":"var(--ink-2)"}}>{r[4]} <span style={{color:"var(--ink-3)"}}>→</span></td>
                  <td style={{textAlign:"right"}}>{r[5]}</td>
                  <td style={{textAlign:"right"}} className="num">{r[6]}</td>
                  <td>{r[7]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{padding:"8px 16px", borderTop:"1px solid var(--hairline)", display:"flex",alignItems:"center",gap:10}}>
          <div className="mono-sm">Showing 8 of 14</div>
          <div style={{flex:1}}/>
          <Kbd>J</Kbd><span className="mono-sm">next</span>
          <Kbd>K</Kbd><span className="mono-sm">prev</span>
          <Kbd>Enter</Kbd><span className="mono-sm">open</span>
        </div>
      </div>

      {/* Right column */}
      <div style={{display:"flex",flexDirection:"column",gap:12,minHeight:0}}>
        {/* Throughput */}
        <div className="wf-card">
          <CardTitle title="Throughput · 14d" eyebrow="orders/day" right={<><Chip kind="ghost">avg 52</Chip></>}/>
          <Bars data={[40,55,38,72,60,45,58,66,48,72,68,82,90,48]} accentAt={12}
                labels={["20","21","22","23","24","25","26","27","28","29","30","01","02","TODAY"]}/>
          <div style={{height:18}}/>
        </div>

        {/* Health */}
        <div className="wf-card" style={{flex:1, display:"flex", flexDirection:"column"}}>
          <CardTitle title="System checks" eyebrow="last run · 09:13:42"/>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              ["Tally bridge · MUM-01","ok","12ms"],
              ["S3 doc storage","ok","18ms"],
              ["LLM provider · primary","ok","cache 73%"],
              ["LLM provider · fallback","warn","queue: 4"],
              ["Webhook · GST portal","ok","fresh"],
              ["Embedding cache","ok","82% hit"],
              ["Email ingest · sales@","fail","auth expired"],
            ].map(([l,s,m],i) => (
              <div key={l} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:i<6?"1px dashed var(--hairline)":"none"}}>
                <Dot kind={s==="ok"?"good":s==="warn"?"warn":"bad"}/>
                <span style={{fontFamily:"var(--sans)", fontSize:12, fontWeight:500}}>{l}</span>
                <div style={{flex:1}}/>
                <span className="mono-sm">{m}</span>
                <Chip kind={s==="ok"?"good":s==="warn"?"warn":"bad"}>{s}</Chip>
              </div>
            ))}
          </div>
          <div style={{flex:1}}/>
          <button className="btn sm ghost" style={{marginTop:10, alignSelf:"flex-start"}}><Ic name="audit" size={11}/>Open integration report</button>
        </div>

        {/* Mini stat row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:0,border:"1px solid var(--ink)"}}>
          <div style={{padding:"12px 14px",borderRight:"1px solid var(--ink)"}}>
            <div className="h-eyebrow" style={{fontSize:9}}>UNBLOCKED TODAY</div>
            <div className="num" style={{fontSize:22,marginTop:4}}>11</div>
            <div className="mono-sm" style={{marginTop:2}}>by Kenith · 6, Riya · 5</div>
          </div>
          <div style={{padding:"12px 14px"}}>
            <div className="h-eyebrow" style={{fontSize:9}}>SLA AT RISK</div>
            <div className="num" style={{fontSize:22,marginTop:4}}>2</div>
            <div className="mono-sm" style={{marginTop:2}}>both Tata Steel · &gt;18h</div>
          </div>
        </div>
      </div>
    </div>

    <Callout x={302} y={138}>queue is the home view — never empty</Callout>
  </Screen>
);

/* ─────────────────────────────────────────────────────────
   B · Exec scorecard — once-a-week, big numbers
   ───────────────────────────────────────────────────────── */
const DashB = () => (
  <Screen url="overview?view=exec" active="Overview" crumbs={["Ops","Overview","Scorecard"]}>
    <div style={{display:"flex", alignItems:"baseline", gap:14}}>
      <div className="h-eyebrow">Period · 01 Apr — 02 May 2026</div>
      <div className="h1" style={{fontSize:30}}>Scorecard</div>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Period: Last 30d ▾</button>
      <button className="btn sm ghost"><Ic name="download" size={11}/>PDF</button>
    </div>

    {/* Big four */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:0,border:"1px solid var(--ink)"}}>
      {[
        ["Orders processed","284","↑ 14%","68% from email · 22% photo · 10% manual"],
        ["Avg cycle time","4h 12m","↓ 18% vs Apr","P50 32m · P95 11h · target ≤8h"],
        ["First-pass accuracy","87%","↑ 4pp","12 review-loops avoided · saves 2.4h/day"],
        ["Cost per SO","₹4.20","↓ ₹1.80","prompt cache · 73% hit rate"],
      ].map((s,i) => (
        <div key={i} style={{padding:"22px 22px",borderRight:i<3?"1px solid var(--ink)":"none",position:"relative",minHeight:180}}>
          <div className="h-eyebrow" style={{fontSize:10}}>{s[0]}</div>
          <div className="num" style={{fontSize:48,lineHeight:1,marginTop:10}}>{s[1]}</div>
          <div className="mono-sm" style={{color:"var(--sage)",marginTop:6,fontSize:11}}>{s[2]}</div>
          <div className="mono-sm" style={{marginTop:14,paddingTop:10,borderTop:"1px dashed var(--hairline)",lineHeight:1.5}}>{s[3]}</div>
          <span className="crosshair" style={{top:6,right:6}}/>
        </div>
      ))}
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1.6fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Volume × value · daily" eyebrow="Apr 01 → May 02" right={<>
          <button className="btn sm ghost">Volume</button>
          <button className="btn sm primary">Value (₹)</button>
        </>}/>
        <div style={{position:"relative",flex:1,minHeight:240,border:"1px solid var(--hairline)",background:"var(--paper-2)",backgroundImage:"linear-gradient(to right, var(--hairline-2) 1px, transparent 1px), linear-gradient(to bottom, var(--hairline-2) 1px, transparent 1px)",backgroundSize:"32px 24px"}}>
          {/* svg chart */}
          <svg viewBox="0 0 600 240" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%"}}>
            {/* value line */}
            <polyline points="0,180 30,160 60,170 90,140 120,120 150,150 180,110 210,130 240,90 270,100 300,80 330,75 360,95 390,60 420,55 450,70 480,40 510,50 540,30 570,45 600,20" fill="none" stroke="var(--ink)" strokeWidth="1.5"/>
            {/* volume bars */}
            {Array.from({length:30}).map((_,i)=>{
              const h = 30+Math.abs(Math.sin(i*0.7))*60+Math.abs(Math.cos(i*1.3))*30;
              return <rect key={i} x={i*20+2} y={240-h} width="14" height={h} fill="var(--accent)" opacity="0.6"/>;
            })}
            {/* forecast dashed */}
            <polyline points="600,20 640,12" fill="none" stroke="var(--ink-3)" strokeWidth="1.2" strokeDasharray="3 3"/>
            {/* axis */}
            <line x1="0" y1="239" x2="600" y2="239" stroke="var(--ink)" strokeWidth="1"/>
          </svg>
          <div style={{position:"absolute",left:8,top:8,fontFamily:"var(--mono)",fontSize:9.5,color:"var(--ink-3)"}}>₹L</div>
          <div style={{position:"absolute",right:8,bottom:8,fontFamily:"var(--mono)",fontSize:9.5,color:"var(--ink-3)"}}>day →</div>
        </div>
        <div style={{display:"flex", gap:18, marginTop:10, fontFamily:"var(--mono)", fontSize:11}}>
          <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:14,height:2,background:"var(--ink)"}}/>Value</span>
          <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:8,height:10,background:"var(--accent)",opacity:0.6}}/>Volume</span>
          <span style={{display:"inline-flex",alignItems:"center",gap:6,color:"var(--ink-3)"}}>┄ Forecast</span>
        </div>
      </div>

      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Top customers · MTD" eyebrow="by ₹ value"/>
        <div style={{display:"flex",flexDirection:"column",gap:9}}>
          {[
            ["Tata Steel · Jamshedpur",92,"₹14,20,400","42 SOs"],
            ["Bosch · Bangalore",70,"₹9,82,000","31 SOs"],
            ["Mahindra · Nashik",54,"₹7,12,800","28 SOs"],
            ["L&T Heavy · Powai",46,"₹6,40,000","12 SOs"],
            ["Cummins · Pune",36,"₹4,90,400","18 SOs"],
            ["Bharat Forge",24,"₹3,28,000","9 SOs"],
            ["JCB India",18,"₹2,40,000","11 SOs"],
          ].map(([n,p,v,c]) => (
            <div key={n}>
              <div style={{display:"flex",alignItems:"baseline",gap:8,fontFamily:"var(--mono)",fontSize:11}}>
                <span style={{flex:1,color:"var(--ink)",fontWeight:500}}>{n}</span>
                <span style={{color:"var(--ink-3)"}}>{c}</span>
                <span style={{fontWeight:600,minWidth:90,textAlign:"right"}}>{v}</span>
              </div>
              <div style={{height:6, background:"var(--paper-2)", border:"1px solid var(--hairline)", marginTop:3}}>
                <div style={{height:"100%",width:p+"%",background:"var(--ink)"}}/>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Risks */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
      {[
        ["bad","Stuck > 24h","6 orders","Procurement bottleneck on 4 · supplier ETA missing"],
        ["warn","High-value pending","₹22L","2 await manager approval · 1 from Cummins"],
        ["warn","Tally backlog","3 vouchers","Bridge retried 09:14 · auto-resume queued"],
      ].map(([k,t,v,s]) => (
        <div key={t} className="wf-box" style={{padding:0,display:"flex"}}>
          <div className="sev-bar" style={{width:5,minHeight:78,background: k==="bad"?"var(--rust)":"var(--amber)"}}/>
          <div style={{flex:1,padding:14,display:"flex",alignItems:"center",gap:14}}>
            <div style={{flex:1}}>
              <div style={{fontFamily:"var(--sans)",fontWeight:700,fontSize:13}}>{t}</div>
              <div className="mono-sm" style={{marginTop:4}}>{s}</div>
            </div>
            <div className="num" style={{fontSize:24}}>{v}</div>
            <button className="btn sm">Open <span className="arrow">→</span></button>
          </div>
        </div>
      ))}
    </div>
  </Screen>
);

/* ─────────────────────────────────────────────────────────
   C · Pipeline kanban — drag-friendly state board
   ───────────────────────────────────────────────────────── */
const DashC = () => {
  const cols = [
    { t:"Inbox",        n:6,  k:"",     items:[["PO-2459","Tata Steel","₹6.2L","12m","email"],["PO-2458","Bosch","₹3.4L","18m","upload"],["PO-2457","Mahindra","₹2.1L","32m","photo"]] },
    { t:"OCR / Extract",n:5,  k:"warn", items:[["PO-2456","Tata Steel","₹6.2L","45m","conf 0.94"],["PO-2454","JCB","₹1.8L","1h","conf 0.71 ⚠"],["PO-2453","Cummins","₹4.4L","1h","conf 0.89"]] },
    { t:"Validate",     n:8,  k:"",     items:[["PO-2452","Bosch","₹4.4L","2h","2 anomalies"],["PO-2450","L&T","₹11.0L","3h","unknown part"],["PO-2449","Bharat Forge","₹2.4L","3h","price comp."]] },
    { t:"Approve",      n:3,  k:"live", items:[["PO-2447","Cummins","₹18.8L","1d","mgr · Riya"],["PO-2445","Tata Steel","₹7.9L","1d","mgr · Riya"]] },
    { t:"Push to Tally",n:4,  k:"warn", items:[["PO-2444","Bosch","₹4.4L","1d","retry 1/3"],["PO-2442","Ashok L.","₹3.1L","1d","queued"],["PO-2441","JCB","₹1.8L","2d","queued"]] },
    { t:"Closed · 30d", n:41, k:"ghost",items:[["PO-2418","Mahindra","₹5.2L","8d","V-8801"],["PO-2415","Tata Steel","₹12.4L","9d","V-8794"],["PO-2412","Bosch","₹3.8L","11d","V-8788"]] },
  ];
  return (
    <Screen url="overview?view=pipeline" active="Overview" crumbs={["Ops","Overview","Pipeline"]}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div className="h2" style={{fontSize:22}}>Pipeline</div>
        <Chip kind="ghost">74 active</Chip>
        <Chip kind="ghost">avg 4h 12m end-to-end</Chip>
        <div style={{flex:1}}/>
        <input className="input" placeholder="Filter customer / PO #…" style={{width:240}}/>
        <button className="btn sm ghost">Group: state ▾</button>
        <button className="btn sm ghost">Owner: anyone ▾</button>
        <button className="btn sm primary"><Ic name="plus" size={11}/>Capture PO</button>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8,flex:1,minHeight:0}}>
        {cols.map((c,i) => (
          <div key={c.t} style={{border:"1px solid var(--ink)",display:"flex",flexDirection:"column",minHeight:0,background:"var(--paper)"}}>
            <div style={{padding:"10px 12px",borderBottom:"1px solid var(--ink)",display:"flex",alignItems:"center",gap:8, background: c.k==="live"?"var(--accent)":"var(--paper)"}}>
              <div style={{fontFamily:"var(--mono)",fontWeight:600,textTransform:"uppercase",fontSize:10,letterSpacing:"0.08em",color:"var(--ink-3)"}}>{String(i+1).padStart(2,"0")}</div>
              <div style={{fontFamily:"var(--sans)",fontWeight:700,fontSize:12.5,letterSpacing:"-0.005em",flex:1}}>{c.t}</div>
              <Chip kind={c.k}>{c.n}</Chip>
            </div>
            <div style={{padding:6,display:"flex",flexDirection:"column",gap:6,overflow:"hidden",flex:1, background:"var(--paper-2)"}}>
              {c.items.map((it,j) => (
                <div key={j} className="wf-box" style={{padding:9, background:"var(--paper)", border:"1px solid var(--hairline)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <span className="mono-sm" style={{color:"var(--ink-3)",fontWeight:600}}>{it[0]}</span>
                    <div style={{flex:1}}/>
                    <span className="mono-sm">{it[3]}</span>
                  </div>
                  <div style={{fontFamily:"var(--sans)",fontWeight:600,fontSize:12, letterSpacing:"-0.005em"}}>{it[1]}</div>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:5,alignItems:"center"}}>
                    <span className="mono-sm" style={{fontWeight:600,color:"var(--ink)"}}>{it[2]}</span>
                    <span className="mono-sm" style={{fontSize:9.5}}>{it[4]}</span>
                  </div>
                </div>
              ))}
              {c.n - c.items.length > 0 && (
                <div className="mono-sm" style={{textAlign:"center",color:"var(--ink-4)",padding:"4px 0",fontSize:10}}>+ {c.n - c.items.length} more</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",gap:14,padding:"6px 4px",fontFamily:"var(--mono)",fontSize:10.5,color:"var(--ink-3)"}}>
        <span>Drag cards across columns to advance state · all moves audit-logged</span>
        <div style={{flex:1}}/>
        <Kbd>1-6</Kbd> jump column · <Kbd>/</Kbd> filter · <Kbd>N</Kbd> new
      </div>
    </Screen>
  );
};

Object.assign(window, { DashA, DashB, DashC });
