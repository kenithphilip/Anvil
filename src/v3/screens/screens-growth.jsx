/* SECTIONS 08–12 (new) — Source POs · Spare Matrix · Communications · Cost simulator/margins · Security */

/* ─────────────────────────────────────────────────────────
   08 · SOURCE POs — supplier-side orders Anvil generates
   ───────────────────────────────────────────────────────── */
const SPOList = () => (
  <Screen url="source-pos" active="Source POs" crumbs={["Ops","Source POs"]}
    topRight={<>
      <button className="btn sm ghost"><Ic name="download" size={11}/>Export</button>
      <button className="btn sm primary"><Ic name="plus" size={11}/>New SPO</button>
    </>}>
    <div style={{display:"flex",alignItems:"baseline",gap:10}}>
      <div className="h1" style={{fontSize:26}}>Source POs</div>
      <Chip kind="ghost">142 open</Chip>
      <Chip kind="warn"><Dot kind="warn"/>8 awaiting supplier</Chip>
      <Chip kind="bad"><Dot kind="bad"/>2 ETA missed</Chip>
      <div style={{flex:1}}/>
      <span className="mono-sm">linked to <b style={{color:"var(--ink)"}}>74 SOs</b> · ₹38.4L purchase value</span>
    </div>

    {/* KPI strip */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:0,border:"1px solid var(--ink)"}}>
      {[
        ["AVG SUPPLIER LEAD","6.2d","P95 14d"],
        ["ON-TIME RATE","78%","↑ 4pp · 30d"],
        ["FILL-RATE","94%","stable"],
        ["PRICE DRIFT","+1.8%","vs Apr median"],
        ["TOTAL VALUE · MTD","₹14.2L","↑ 9%"],
      ].map(([l,v,d],i) => (
        <div key={l} style={{padding:"14px 16px", borderRight:i<4?"1px solid var(--ink)":"none"}}>
          <div className="h-eyebrow" style={{fontSize:9}}>{l}</div>
          <div className="num" style={{fontSize:24, marginTop:6}}>{v}</div>
          <div className="mono-sm" style={{marginTop:4}}>{d}</div>
        </div>
      ))}
    </div>

    <div className="wf-card" style={{flex:1, padding:0, display:"flex", flexDirection:"column", minHeight:0}}>
      <div style={{padding:"10px 14px", borderBottom:"1px solid var(--ink)", display:"flex", gap:8, alignItems:"center"}}>
        <div className="h3">All SPOs</div>
        <div style={{flex:1}}/>
        <input className="input" style={{width:240}} placeholder="⌕ supplier, part, SPO #…"/>
        <select className="select" style={{width:160}}><option>State · all</option></select>
      </div>
      <div style={{flex:1, overflow:"hidden"}}>
        <table className="tbl">
          <thead><tr><th>SPO #</th><th>Supplier</th><th>For</th><th>State</th><th>Lines</th><th style={{textAlign:"right"}}>Value</th><th>ETA</th><th>OTIF</th><th>Score</th></tr></thead>
          <tbody>
            {[
              ["live","SPO-882","Skf India · BLR","SO-1042 (Tata)","awaiting-ack",4,"₹2,14,000","08-May","—","A"],
              ["",    "SPO-881","Bosch Rexroth","SO-1040 (Bosch)","confirmed",2,"₹1,82,400","06-May","on-track","A"],
              ["bad", "SPO-880","Apex Bearings","SO-1037 (JCB)","ETA missed",6,"₹84,200","01-May","-3d","C"],
              ["warn","SPO-879","Rane Group","SO-1039 (L&T)","price-changed",8,"₹3,40,000","12-May","review","B"],
              ["",    "SPO-878","Sundram Fasteners","SO-1038 (Cummins)","received",12,"₹1,12,400","done","100%","A+"],
              ["",    "SPO-877","Wipro Lighting","SO-1036 (Ashok L.)","invoiced",4,"₹64,200","done","on-time","A"],
              ["",    "SPO-876","Greaves","SO-1035","received",2,"₹38,400","done","100%","A"],
              ["warn","SPO-875","Endurance Tech","SO-1033 (Tata)","partial-recv",18,"₹4,02,000","08-May","fill 88%","B"],
            ].map((r,i)=>(
              <tr key={i} className={r[0]==="live"?"row-live":r[0]==="bad"?"row-flag":r[0]==="warn"?"row-warn":""}>
                <td><span className="pri">{r[1]}</span></td>
                <td>{r[2]}</td>
                <td className="mono-sm" style={{color:"var(--ink-2)"}}>{r[3]}</td>
                <td><Chip kind={r[4]==="ETA missed"?"bad":r[4]==="received"||r[4]==="invoiced"?"good":r[4]==="awaiting-ack"||r[4]==="price-changed"||r[4]==="partial-recv"?"warn":""}>{r[4]}</Chip></td>
                <td style={{textAlign:"right"}}>{r[5]}</td>
                <td style={{textAlign:"right",fontWeight:600}}>{r[6]}</td>
                <td>{r[7]}</td>
                <td>{r[8]}</td>
                <td><Chip kind={r[9]==="A+"||r[9]==="A"?"good":r[9]==="B"?"warn":"bad"}>{r[9]}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </Screen>
);

const SPODetail = () => (
  <Screen url="source-pos/SPO-882" active="Source POs" crumbs={["Ops","Source POs","SPO-882"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h-eyebrow">For SO-1042 · Tata Steel</div>
      <div className="h1" style={{fontSize:24}}>SPO-882 → Skf India</div>
      <Chip kind="warn"><Dot kind="warn"/>awaiting supplier ack</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Cancel SPO</button>
      <button className="btn sm">Resend</button>
      <button className="btn sm primary">Mark received</button>
    </div>

    {/* Timeline */}
    <Steps items={["Drafted","Sent","Acknowledged","In transit","Received","Invoiced"]} current={1}/>

    <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Lines · 4" eyebrow="auto-routed from SO-1042"/>
        <table className="tbl">
          <thead><tr><th>#</th><th>Part</th><th style={{textAlign:"right"}}>Qty</th><th style={{textAlign:"right"}}>Quoted</th><th style={{textAlign:"right"}}>SPO rate</th><th style={{textAlign:"right"}}>Δ</th><th>Margin</th></tr></thead>
          <tbody>
            <tr><td>1</td><td>BR-6204-ZZ</td><td style={{textAlign:"right"}}>100</td><td style={{textAlign:"right"}}>₹140.00</td><td style={{textAlign:"right",fontWeight:600}}>₹138.50</td><td style={{textAlign:"right",color:"var(--sage)"}}>−1.1%</td><td><Chip kind="good">24.7%</Chip></td></tr>
            <tr><td>2</td><td>OS-25-42-7</td><td style={{textAlign:"right"}}>250</td><td style={{textAlign:"right"}}>₹17.20</td><td style={{textAlign:"right",fontWeight:600}}>₹17.20</td><td style={{textAlign:"right",color:"var(--ink-3)"}}>flat</td><td><Chip kind="good">23.6%</Chip></td></tr>
            <tr><td>3</td><td>CL-INT-22</td><td style={{textAlign:"right"}}>500</td><td style={{textAlign:"right"}}>₹3.10</td><td style={{textAlign:"right",fontWeight:600}}>₹3.40</td><td style={{textAlign:"right",color:"var(--rust)"}}>+9.7%</td><td><Chip kind="warn">17.1%</Chip></td></tr>
            <tr className="row-warn"><td>4</td><td>UCFL-204</td><td style={{textAlign:"right"}}>40</td><td style={{textAlign:"right"}}>₹520.00</td><td style={{textAlign:"right",fontWeight:600}}>₹544.00</td><td style={{textAlign:"right",color:"var(--rust)"}}>+4.6%</td><td><Chip kind="warn">11.1%</Chip></td></tr>
          </tbody>
        </table>
        <div className="wf-divider" style={{margin:"12px 0"}}/>
        <div style={{display:"flex",gap:14,alignItems:"center"}}>
          <span className="mono-sm">Subtotal <b style={{color:"var(--ink)"}}>₹2,14,000</b> · GST <b style={{color:"var(--ink)"}}>₹38,520</b> · Total <b style={{color:"var(--ink)"}}>₹2,52,520</b></span>
          <div style={{flex:1}}/>
          <Chip kind="warn">price drift +2.1% vs quote</Chip>
        </div>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:12,minHeight:0}}>
        <div className="wf-card">
          <CardTitle title="Supplier"/>
          <KV rows={[
            ["Name","Skf India Pvt Ltd"],
            ["Branch","Bangalore · KA"],
            ["GSTIN","29AABCS8765F1Z3"],
            ["Contact","sales@skf-blr.com"],
            ["Phone","+91 80 4112 9900"],
            ["Payment","30d net · approved"],
          ]}/>
        </div>
        <div className="wf-card" style={{flex:1}}>
          <CardTitle title="Activity"/>
          <div style={{fontFamily:"var(--mono)",fontSize:10.5,display:"flex",flexDirection:"column",gap:6}}>
            {[
              ["09:42","KP","SPO drafted from SO-1042 split-routing"],
              ["09:43","sys","XML pushed to supplier portal · 200"],
              ["09:43","sys","email sent · sales@skf-blr.com"],
              ["—","—","awaiting ack (SLA 4h business)"],
            ].map(([t,a,m],i) => (
              <div key={i} style={{display:"grid",gridTemplateColumns:"40px 36px 1fr",gap:8,paddingBottom:6,borderBottom:i<3?"1px dashed var(--hairline)":"none"}}>
                <span style={{color:"var(--ink-4)"}}>{t}</span>
                <span style={{color:"var(--ink-3)"}}>{a}</span>
                <span>{m}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </Screen>
);

const SupplierScorecard = () => (
  <Screen url="source-pos/suppliers" active="Source POs" crumbs={["Ops","Source POs","Suppliers"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Supplier scorecards</div>
      <Chip kind="ghost">38 active</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Period: 90d ▾</button>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
      {[
        ["Skf India · BLR","A","96","98","2.1","18 SPOs · ₹4.2L"],
        ["Bosch Rexroth","A","94","100","1.4","12 SPOs · ₹3.8L"],
        ["Sundram Fasteners","A+","99","99","0.8","22 SPOs · ₹1.4L"],
        ["Rane Group","B","82","94","4.2","9 SPOs · ₹2.1L"],
        ["Apex Bearings","C","61","78","8.1","6 SPOs · ₹0.9L"],
        ["Endurance Tech","B","78","88","3.4","11 SPOs · ₹2.8L"],
      ].map(([n,g,otif,fill,lead,vol]) => (
        <div key={n} className="wf-card" style={{padding:0}}>
          <div style={{padding:"14px 16px",borderBottom:"1px solid var(--ink)",display:"flex",alignItems:"center",gap:10}}>
            <div style={{flex:1}}>
              <div className="h3" style={{marginBottom:2}}>{n}</div>
              <div className="mono-sm">{vol}</div>
            </div>
            <div className="num" style={{fontSize:30,lineHeight:1,padding:"6px 10px",border:"1px solid var(--ink)",background: g==="A+"||g==="A"?"var(--accent)":g==="B"?"var(--paper-2)":"var(--rust)", color: g==="C"?"var(--paper)":"var(--ink)"}}>{g}</div>
          </div>
          <div style={{padding:14, display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:0}}>
            {[["OTIF",otif+"%"],["FILL",fill+"%"],["LEAD",lead+"d"]].map(([l,v],i)=>(
              <div key={l} style={{borderRight:i<2?"1px dashed var(--hairline)":"none",padding:"0 8px"}}>
                <div className="h-eyebrow" style={{fontSize:9}}>{l}</div>
                <div className="num" style={{fontSize:18,marginTop:4}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{padding:"0 14px 14px"}}>
            <Spark data={[40,55,38,72,60,90,75,88,82,94,86,92]}/>
          </div>
        </div>
      ))}
    </div>
  </Screen>
);

/* ─────────────────────────────────────────────────────────
   09 · SPARE MATRIX — recommended spares per primary part
   ───────────────────────────────────────────────────────── */
const SpareMatrix = () => (
  <Screen url="spare-matrix" active="Spare Matrix" crumbs={["Growth","Spare Matrix"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Spare-part recommendations</div>
      <Chip kind="ghost">412 mappings</Chip>
      <Chip kind="live"><Dot kind="live"/>14 new opportunities</Chip>
      <div style={{flex:1}}/>
      <span className="mono-sm">attached to <b style={{color:"var(--ink)"}}>38%</b> of SOs · ₹4.8L incremental MTD</span>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12, flex:1, minHeight:0}}>
      <div className="wf-card" style={{padding:0,display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--ink)",display:"flex",alignItems:"center",gap:8}}>
          <div className="h3">Matrix</div>
          <Chip kind="ghost">primary × spare · co-occurrence</Chip>
        </div>
        <div style={{padding:14, overflow:"auto"}}>
          {/* Matrix grid */}
          <table className="tbl tbl-clean" style={{borderCollapse:"separate", borderSpacing:0}}>
            <thead><tr>
              <th style={{position:"sticky",left:0,background:"var(--paper)"}}>Primary ↓ / Spare →</th>
              {["6204-2RS","Oil seal","Circlip","Grease","V-belt","Coupling"].map(s=><th key={s} style={{textAlign:"center"}}>{s.slice(0,8)}</th>)}
            </tr></thead>
            <tbody>
              {[
                ["UCFL-204",[92,88,76,40,8,0]],
                ["UCFL-206",[85,80,72,38,4,0]],
                ["Pillow block PB-25",[78,82,66,72,12,8]],
                ["Motor 2.2kW",[14,32,8,68,84,72]],
                ["Gearbox NMRV-50",[6,40,12,80,18,88]],
                ["Pump CR-5",[18,76,42,62,8,12]],
              ].map(([p, vals]) => (
                <tr key={p}>
                  <td style={{position:"sticky",left:0,background:"var(--paper)",fontWeight:600}}>{p}</td>
                  {vals.map((v,i)=>(
                    <td key={i} style={{textAlign:"center",padding:0,height:36,width:64}}>
                      <div style={{margin:2, height:32, background: v >= 70?"var(--accent)":v>=40?"var(--paper-2)":v>=10?"var(--paper-3)":"transparent", border:"1px solid var(--hairline)", display:"grid",placeItems:"center", color: v>=70?"var(--ink)":"var(--ink-3)", fontWeight: v>=70?700:400, fontSize:11}}>
                        {v >= 10 ? v + "%" : "·"}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{display:"flex",gap:14,marginTop:14,fontFamily:"var(--mono)",fontSize:10}}>
            <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:14,height:14,background:"var(--accent)",border:"1px solid var(--ink)"}}/>≥70% co-occur</span>
            <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:14,height:14,background:"var(--paper-2)",border:"1px solid var(--hairline)"}}/>40–69%</span>
            <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:14,height:14,background:"var(--paper-3)",border:"1px solid var(--hairline)"}}/>10–39%</span>
          </div>
        </div>
      </div>

      <div className="wf-card" style={{padding:0,display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--ink)",display:"flex",alignItems:"center",gap:8}}>
          <div className="h3">Selected · UCFL-204</div>
          <div style={{flex:1}}/>
          <Chip><Dot kind="info"/>92 SOs in 90d</Chip>
        </div>
        <div style={{padding:14,flex:1,display:"flex",flexDirection:"column",gap:14}}>
          <div className="kv" style={{gridTemplateColumns:"140px 1fr"}}>
            <dt>Master SKU</dt><dd>UCFL-204</dd>
            <dt>Avg margin</dt><dd>22.4%</dd>
            <dt>Top customers</dt><dd>Tata Steel · Mahindra · L&T</dd>
            <dt>Spare-attach</dt><dd>62% (target 75%)</dd>
          </div>
          <div className="wf-divider"/>
          <div className="h-eyebrow">Recommended spares · co-purchased ≥40%</div>
          <table className="tbl">
            <thead><tr><th>Part</th><th style={{textAlign:"right"}}>Co-occur</th><th style={{textAlign:"right"}}>Avg qty</th><th style={{textAlign:"right"}}>Margin</th><th></th></tr></thead>
            <tbody>
              <tr><td>BR-6204-ZZ</td><td style={{textAlign:"right",fontWeight:600}}>92%</td><td style={{textAlign:"right"}}>2.4×</td><td style={{textAlign:"right"}}>24.7%</td><td><Chip kind="live">attach</Chip></td></tr>
              <tr><td>OS-25-42-7</td><td style={{textAlign:"right",fontWeight:600}}>88%</td><td style={{textAlign:"right"}}>2.0×</td><td style={{textAlign:"right"}}>23.6%</td><td><Chip kind="live">attach</Chip></td></tr>
              <tr><td>CL-INT-22</td><td style={{textAlign:"right",fontWeight:600}}>76%</td><td style={{textAlign:"right"}}>4.2×</td><td style={{textAlign:"right"}}>17.1%</td><td><Chip kind="ghost">offer</Chip></td></tr>
              <tr><td>Grease nipple M6</td><td style={{textAlign:"right",fontWeight:600}}>40%</td><td style={{textAlign:"right"}}>1.0×</td><td style={{textAlign:"right"}}>31.2%</td><td><Chip kind="ghost">offer</Chip></td></tr>
            </tbody>
          </table>
          <div className="wf-box" style={{display:"flex",alignItems:"center",gap:10,padding:12,background:"var(--paper-2)"}}>
            <Pin n="!"/>
            <div className="annot" style={{flex:1}}>Tata Steel buys UCFL-204 without bearings <b>3× more often</b> than the network. <b>+₹84k/mo</b> opportunity if attach &gt; 80%.</div>
            <button className="btn sm primary">Open campaign <span className="arrow">→</span></button>
          </div>
        </div>
      </div>
    </div>
  </Screen>
);

const SpareOpportunities = () => (
  <Screen url="spare-matrix/opportunities" active="Spare Matrix" crumbs={["Growth","Spare Matrix","Opportunities"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Opportunities</div>
      <Chip kind="live"><Dot kind="live"/>14 new this week</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Sort: ₹ impact ▾</button>
      <button className="btn sm primary">Bulk: queue drafts</button>
    </div>

    <table className="tbl">
      <thead><tr><th></th><th>Customer</th><th>Pattern</th><th>Suggested SPO</th><th style={{textAlign:"right"}}>Est. ₹/mo</th><th>Confidence</th><th>Action</th></tr></thead>
      <tbody>
        {[
          ["high","Tata Steel · Jamshedpur","UCFL-204 ordered, no bearings since 90d","Add BR-6204-ZZ × 2 per UCFL","₹84,000","0.92","Draft email"],
          ["high","Mahindra · Nashik","Pillow block PB-25 + no grease","Annual lubrication kit","₹48,000","0.88","Draft email"],
          ["med", "Bosch · BLR","Motor 2.2kW · belts overdue","V-belt set + tensioner","₹32,000","0.78","Draft email"],
          ["med", "L&T Heavy","Coupling NMRV-50 · spare ratio < 1","Stock+1 spare coupling","₹28,500","0.72","Notify rep"],
          ["low", "JCB India","Quarterly grease drift","Q2 scheduled refill","₹14,200","0.65","Snooze 30d"],
          ["low", "Cummins","Oil seal pattern · seasonal","Pre-monsoon push","₹9,400","0.60","Snooze 30d"],
        ].map(([sev,c,p,s,v,conf,a],i) => (
          <tr key={i}>
            <td><span className={"sev-bar "+(sev==="high"?"high":sev==="med"?"med":"low")}/></td>
            <td><span className="pri">{c}</span></td>
            <td className="mono-sm" style={{color:"var(--ink-2)"}}>{p}</td>
            <td>{s}</td>
            <td style={{textAlign:"right",fontWeight:600}}>{v}</td>
            <td style={{textAlign:"right"}}>{conf}</td>
            <td><button className="btn sm">{a}</button></td>
          </tr>
        ))}
      </tbody>
    </table>

    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
      {[
        ["Total potential","₹2,16,100","this month · across 14 customers"],
        ["Already converted","₹78,400","36% conversion · 30d trailing"],
        ["Avg time to attach","2.4 SOs","from suggest → first attach"],
      ].map(([l,v,d])=>(
        <div key={l} className="wf-card">
          <div className="h-eyebrow">{l}</div>
          <div className="num" style={{fontSize:30,marginTop:6}}>{v}</div>
          <div className="mono-sm" style={{marginTop:6}}>{d}</div>
        </div>
      ))}
    </div>
  </Screen>
);

const ObsoletePartsScreen = () => (
  <Screen url="spare-matrix/obsolete" active="Spare Matrix" crumbs={["Growth","Spare Matrix","Obsolete & risk"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Obsolete & at-risk SKUs</div>
      <div style={{flex:1}}/>
      <span className="mono-sm">Anvil flags SKUs with ≥120d no-orders, declining attach, or supplier EOL</span>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1.2fr 1fr",gap:12, flex:1, minHeight:0}}>
      <div className="wf-card" style={{padding:0, display:"flex", flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--ink)",display:"flex",alignItems:"center"}}>
          <div className="h3">14 SKUs flagged</div>
          <div style={{flex:1}}/>
          <Chip kind="bad">3 supplier-EOL</Chip>
          <Chip kind="warn">8 declining</Chip>
          <Chip kind="ghost">3 dead stock</Chip>
        </div>
        <table className="tbl">
          <thead><tr><th>SKU</th><th>Reason</th><th>Last sold</th><th style={{textAlign:"right"}}>On hand</th><th>Successor</th><th></th></tr></thead>
          <tbody>
            {[
              ["BR-6204-V1 (old rev)","supplier EOL · superseded","182d ago","48","BR-6204-ZZ","Migrate"],
              ["UCFL-204-OLD","declining 18mo","94d ago","12","UCFL-204","Migrate"],
              ["GREASE-LITHIUM-3kg","attach -42% YoY","61d ago","6","GREASE-LITH-PRO","Replace"],
              ["BELT-A47-OLD","declining 24mo","148d ago","22","BELT-A47-PWR","Migrate"],
              ["SEAL-25-42-OLD","dead stock","220d ago","82","OS-25-42-7","Liquidate"],
              ["NIPPLE-M6-BR","supplier EOL","45d ago","140","NIPPLE-M6-SS","Replace"],
            ].map((r,i)=>(
              <tr key={i}>
                <td><span className="pri">{r[0]}</span></td>
                <td className="mono-sm">{r[1]}</td>
                <td>{r[2]}</td>
                <td style={{textAlign:"right"}}>{r[3]}</td>
                <td>{r[4]}</td>
                <td><button className="btn sm">{r[5]}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="wf-card">
        <CardTitle title="Selected · BR-6204-V1" eyebrow="supplier EOL since 18 Mar"/>
        <KV rows={[
          ["On hand","48 NOS · ₹6,720"],
          ["Last sold","182d ago · Tata Steel"],
          ["Avg margin","19.2%"],
          ["Successor","BR-6204-ZZ · 100% spec match"],
          ["Customers affected","12 · auto-mapped"],
          ["Liquidation","sale @ −10% to clear"],
        ]}/>
        <div className="wf-divider" style={{margin:"14px 0"}}/>
        <div className="h-eyebrow">Plan</div>
        <ol style={{fontFamily:"var(--mono)",fontSize:11,lineHeight:1.7,paddingLeft:18,marginTop:6}}>
          <li>Add successor to all 12 customer aliases</li>
          <li>Email customers · 30d notice</li>
          <li>Liquidate stock at −10% by 30 Jun</li>
          <li>Block re-order on master · status=EOL</li>
        </ol>
        <button className="btn primary sm" style={{marginTop:14}}>Run migration plan <span className="arrow">→</span></button>
      </div>
    </div>
  </Screen>
);

/* ─────────────────────────────────────────────────────────
   10 · COMMUNICATIONS — drafts, missing-doc nudges
   ───────────────────────────────────────────────────────── */
const CommsInbox = () => (
  <Screen url="comms" active="Communications" crumbs={["Growth","Communications"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Communications</div>
      <Chip kind="ghost">26 drafts</Chip>
      <Chip kind="warn">8 missing-doc</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Templates</button>
      <button className="btn sm primary"><Ic name="plus" size={11}/>New draft</button>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"320px 1fr",gap:12,flex:1,minHeight:0}}>
      {/* List */}
      <div className="wf-card" style={{padding:0,display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--ink)",display:"flex",gap:6}}>
          <button className="btn sm" style={{flex:1, background:"var(--ink)", color:"var(--paper)"}}>Drafts (26)</button>
          <button className="btn sm ghost" style={{flex:1}}>Sent</button>
          <button className="btn sm ghost" style={{flex:1}}>Replies</button>
        </div>
        <div style={{flex:1,overflow:"auto"}}>
          {[
            ["live","Tata Steel · Order confirmation","SO-1042 · 18 lines","just now","conf 0.94"],
            ["",    "Mahindra · Missing PO doc","SO-1041 · awaiting copy","12m","auto"],
            ["",    "Bosch · Spare attach","UCFL-204 → +bearings","32m","auto"],
            ["",    "L&T · Lead-time advice","SPO-879 +3d","1h","manual"],
            ["",    "JCB · Q2 grease push","seasonal","2h","auto"],
            ["",    "Cummins · Approval request","SO-1038 · ₹18.8L","3h","manual"],
            ["",    "Ashok L. · Invoice copy","V-9923","1d","auto"],
            ["",    "Bharat Forge · Quote follow-up","Q-1188 · 7d aged","2d","auto"],
          ].map(([k,t,s,when,kind],i)=>(
            <div key={i} style={{padding:"10px 14px", borderBottom:"1px dashed var(--hairline)", background: i===0?"var(--paper-2)":"var(--paper)", borderLeft: i===0?"2px solid var(--accent)":"2px solid transparent"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                <Dot kind={k||"muted"}/>
                <span style={{fontFamily:"var(--sans)",fontWeight:600,fontSize:12.5,flex:1,letterSpacing:"-0.005em"}}>{t}</span>
                <span className="mono-sm" style={{fontSize:9.5}}>{when}</span>
              </div>
              <div className="mono-sm" style={{fontSize:10.5,marginLeft:14}}>{s}</div>
              <div style={{marginLeft:14,marginTop:4}}><Chip kind="ghost">{kind}</Chip></div>
            </div>
          ))}
        </div>
      </div>

      {/* Composer */}
      <div className="wf-card" style={{padding:0,display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--ink)",display:"flex",alignItems:"center",gap:8}}>
          <div className="h3">Tata Steel · Order confirmation</div>
          <Chip kind="live"><Dot kind="live"/>drafted by Anvil · 0.94</Chip>
          <div style={{flex:1}}/>
          <button className="btn sm ghost">Regenerate</button>
          <button className="btn sm">Save</button>
          <button className="btn sm primary">Send <span className="arrow">→</span></button>
        </div>
        <div style={{padding:14,display:"grid",gridTemplateColumns:"100px 1fr",gap:"6px 14px",borderBottom:"1px dashed var(--hairline)",fontFamily:"var(--mono)",fontSize:11}}>
          <span style={{color:"var(--ink-3)"}}>To</span><span><b>procurement@tatasteel.com</b>, k.bose@tatasteel.com</span>
          <span style={{color:"var(--ink-3)"}}>Cc</span><span>r.mehra@anvil.app (mgr)</span>
          <span style={{color:"var(--ink-3)"}}>Subject</span><span>Order confirmation · SO-1042 against PO-2456 · 18 lines · ₹7.32L</span>
          <span style={{color:"var(--ink-3)"}}>Attached</span><span>SO-1042.pdf · price-comp-tata.xlsx</span>
        </div>
        <div style={{padding:18,fontFamily:"var(--sans)",fontSize:13,lineHeight:1.65,color:"var(--ink-2)",flex:1,overflow:"auto"}}>
          <p>Dear Mr Bose,</p>
          <p>Confirming receipt of your PO-2456 dated 02-May-26. We've matched all 18 lines against your part list and have one item to verify before we ship:</p>
          <p style={{borderLeft:"2px solid var(--accent)",paddingLeft:10,marginLeft:0,fontFamily:"var(--mono)",fontSize:12, background:"var(--paper-2)",padding:"8px 10px"}}>
            <b>Line 6 — BRG-6205-2RS · qty 100 @ ₹1,840.00/NOS.</b><br/>
            Your last 12 orders for this part were at ₹184.00. Could you confirm whether the new rate is intentional? If it's a typo, we'll proceed at the historical rate.
          </p>
          <p>All other lines are confirmed at PO rates. We'll dispatch from our Pune warehouse on 12-May, ETA Jamshedpur 14-May.</p>
          <p>Thanks,<br/>Kenith Philip · Anvil Industrial Supplies</p>
          <div className="mono-sm" style={{marginTop:18,paddingTop:10,borderTop:"1px dashed var(--hairline)"}}>
            attached audit packet · po-tata-2456.pdf · extraction trace
          </div>
        </div>
        <div style={{padding:"10px 14px",borderTop:"1px solid var(--ink)",display:"flex",alignItems:"center",gap:10,fontFamily:"var(--mono)",fontSize:10.5}}>
          <Chip kind="ghost">tone: formal · workshop English</Chip>
          <Chip kind="ghost">policy: anomaly-reveal</Chip>
          <Chip kind="ghost">redaction: phone numbers ✓</Chip>
          <div style={{flex:1}}/>
          <span>tokens: 412 in · 280 out · ₹0.18</span>
        </div>
      </div>
    </div>
  </Screen>
);

const CommsMissingDoc = () => (
  <Screen url="comms/missing-docs" active="Communications" crumbs={["Growth","Communications","Missing docs"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Missing-doc nudges</div>
      <Chip kind="warn">8 customers</Chip>
      <Chip kind="ghost">avg 2.1 days aged</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm primary">Send all 8 nudges</button>
    </div>

    <div className="wf-box" style={{padding:14,display:"flex",alignItems:"flex-start",gap:14,background:"var(--paper-2)"}}>
      <Pin n="i"/>
      <div className="annot" style={{flex:1}}>
        Anvil tracks docs <i>expected</i> for each open SO — PO copies, GST exemption certs, dispatch authorisation, etc. When a doc has been missing &gt; SLA, it lands here for a polite nudge.
      </div>
    </div>

    <table className="tbl">
      <thead><tr><th>Customer</th><th>Order</th><th>Missing</th><th>Aged</th><th>Last reminder</th><th>Channel</th><th></th></tr></thead>
      <tbody>
        {[
          ["Mahindra · Nashik","SO-1041","Original PO copy","2d","none","email · WhatsApp"],
          ["Cummins · Pune","SO-1038","GST exemption cert (SEZ)","3d","1d ago","email"],
          ["L&T Heavy","SO-1039","Authorised buyer signature","1d","none","email"],
          ["Bharat Forge","Q-1188","Quote acceptance","7d","4d ago","email · phone"],
          ["JCB India","SO-1037","Dispatch address confirmation","2d","none","WhatsApp"],
          ["Bosch · BLR","SO-1040","Updated payment terms","3d","2d ago","email"],
          ["Ashok Leyland","SO-1036","E-way bill acknowledgement","1d","none","email"],
          ["Tata Steel","SO-1042","Vendor code refresh","4d","2d ago","email"],
        ].map((r,i)=>(
          <tr key={i}>
            <td><span className="pri">{r[0]}</span></td>
            <td>{r[1]}</td>
            <td>{r[2]}</td>
            <td><Chip kind={parseInt(r[3])>2?"warn":"ghost"}>{r[3]}</Chip></td>
            <td>{r[4]}</td>
            <td className="mono-sm">{r[5]}</td>
            <td><button className="btn sm primary">Draft nudge</button></td>
          </tr>
        ))}
      </tbody>
    </table>

    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
      {[
        ["Reply rate","73%","within 2 business days"],
        ["Avg time to clear","1.6d","once nudged"],
        ["Avoided cancellations","₹2.4L","this quarter"],
      ].map(([l,v,d])=>(
        <div key={l} className="wf-card">
          <div className="h-eyebrow">{l}</div>
          <div className="num" style={{fontSize:26,marginTop:6}}>{v}</div>
          <div className="mono-sm" style={{marginTop:4}}>{d}</div>
        </div>
      ))}
    </div>
  </Screen>
);

const CommsTemplates = () => (
  <Screen url="comms/templates" active="Communications" crumbs={["Growth","Communications","Templates"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Templates</div>
      <Chip kind="ghost">14 active</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm primary"><Ic name="plus" size={11}/>New template</button>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12}}>
      {[
        ["Order confirmation","auto", "Sent on every SO push", "412 sent · 73% reply", "live"],
        ["Anomaly verification","auto", "Sent when value 5×+ off historical", "26 sent · 96% verified", ""],
        ["Missing PO copy","auto", "Sent at 48h aged", "84 sent · 1.6d clear", ""],
        ["GST cert reminder","auto", "Sent at 72h aged", "18 sent · 89% reply", ""],
        ["Spare attach offer","manual","After SO with no spares", "62 sent · 38% conversion", ""],
        ["Quote follow-up","auto","7d / 14d / 30d aged", "144 sent · 24% close", ""],
        ["Lead-time advisory","manual","SPO ETA changed >2d", "32 sent", ""],
        ["Year-end stock liquidation","manual","Mar quarter only", "8 sent · 62% conversion", ""],
      ].map(([n,k,d,m,h]) => (
        <div key={n} className="wf-card" style={{display:"flex",alignItems:"flex-start",gap:14, background: h==="live"?"var(--paper-2)":"var(--paper)"}}>
          <div style={{width:34,height:34,border:"1px solid var(--ink)",display:"grid",placeItems:"center",fontFamily:"var(--mono)",fontSize:9,fontWeight:600,background: k==="auto"?"var(--accent)":"var(--paper-2)"}}>{k.slice(0,4).toUpperCase()}</div>
          <div style={{flex:1}}>
            <div style={{display:"flex",alignItems:"baseline",gap:8}}>
              <div className="h3" style={{fontSize:13,letterSpacing:0,textTransform:"none"}}>{n}</div>
              <Chip kind={k==="auto"?"live":"ghost"}>{k}</Chip>
              {h==="live" && <Chip kind="good">in-use</Chip>}
            </div>
            <div className="mono-sm" style={{marginTop:6}}>{d}</div>
            <div className="mono-sm" style={{marginTop:4,color:"var(--ink-2)"}}>{m}</div>
          </div>
          <button className="btn sm ghost">Edit</button>
        </div>
      ))}
    </div>
  </Screen>
);

/* ─────────────────────────────────────────────────────────
   12 · COST simulator + margin history
   ───────────────────────────────────────────────────────── */
const CostSimulatorDemo = () => (
  <Screen url="cost/simulator" active="Cost & Margin" crumbs={["Growth","Cost & Margin","Simulator"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Cost simulator</div>
      <Chip kind="ghost">what-if · LLM + human + cache</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Reset</button>
      <button className="btn sm primary">Save scenario</button>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"360px 1fr",gap:12,flex:1,minHeight:0}}>
      {/* Inputs */}
      <div className="wf-card" style={{display:"flex",flexDirection:"column",gap:14}}>
        <CardTitle title="Inputs"/>
        {[
          ["Orders / month", "320", "input"],
          ["Avg lines / order", "12", "input"],
          ["Cache hit rate", "73%", "slider"],
          ["Manual review rate", "18%", "slider"],
          ["Operator hourly cost", "₹420", "input"],
          ["Realtime mode share", "12%", "slider"],
        ].map(([l,v,k])=>(
          <div key={l}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <label className="label" style={{margin:0}}>{l}</label>
              <span className="num" style={{fontSize:14}}>{v}</span>
            </div>
            {k==="slider" ? (
              <div style={{marginTop:6,height:8,background:"var(--paper-2)",border:"1px solid var(--hairline)",position:"relative"}}>
                <div style={{height:"100%",width: l.includes("Cache") ? "73%" : l.includes("Manual") ? "18%" : "12%", background:"var(--ink)"}}/>
                <div style={{position:"absolute", left: (l.includes("Cache") ? "73%" : l.includes("Manual") ? "18%" : "12%"), top:-4, width:14, height:14, background:"var(--accent)", border:"1px solid var(--ink)", transform:"translateX(-50%)"}}/>
              </div>
            ) : <input className="input" defaultValue={v} style={{marginTop:6}}/>}
          </div>
        ))}
      </div>

      {/* Outputs */}
      <div style={{display:"flex",flexDirection:"column",gap:12,minHeight:0}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:0,border:"1px solid var(--ink)"}}>
          {[
            ["COST / SO","₹4.20","↓ ₹1.80 vs no-cache"],
            ["MONTHLY SPEND","₹1,344","320 SOs"],
            ["TIME / SO","8.4 min","↓ 14m vs manual"],
          ].map(([l,v,d],i)=>(
            <div key={l} style={{padding:"18px 18px",borderRight:i<2?"1px solid var(--ink)":"none",background: i===0?"var(--accent)":"var(--paper)"}}>
              <div className="h-eyebrow">{l}</div>
              <div className="num" style={{fontSize:30,marginTop:6,lineHeight:1}}>{v}</div>
              <div className="mono-sm" style={{marginTop:4}}>{d}</div>
            </div>
          ))}
        </div>

        <div className="wf-card" style={{flex:1,display:"flex",flexDirection:"column"}}>
          <CardTitle title="Cost breakdown · per SO" eyebrow="₹4.20 split"/>
          <div style={{display:"flex",height:42,border:"1px solid var(--ink)"}}>
            {[
              ["LLM input",1.20,"var(--ink)"],
              ["LLM output",0.84,"var(--ink-2)"],
              ["Cache reads",0.18,"var(--accent)"],
              ["Storage",0.32,"var(--paper-2)"],
              ["Human review (avg)",1.66,"var(--lapis)"],
            ].map(([l,v,c],i,arr)=>(
              <div key={l} style={{flex:v,background:c,borderRight:i<arr.length-1?"1px solid var(--ink)":"none",position:"relative"}}>
                <div style={{position:"absolute",bottom:"100%",left:6,fontFamily:"var(--mono)",fontSize:9,color:"var(--ink-3)",whiteSpace:"nowrap",paddingBottom:4}}>{l} · ₹{v.toFixed(2)}</div>
              </div>
            ))}
          </div>
          <div className="wf-divider" style={{margin:"22px 0 14px"}}/>
          <CardTitle title="Sensitivity" eyebrow="impact of each lever on ₹/SO" />
          <table className="tbl">
            <thead><tr><th>Lever</th><th>Range tested</th><th>₹/SO at min</th><th>₹/SO at max</th><th>Sensitivity</th></tr></thead>
            <tbody>
              <tr><td>Cache hit rate</td><td>40% → 90%</td><td>₹6.10</td><td>₹3.40</td><td><Chip kind="live">high</Chip></td></tr>
              <tr><td>Manual review rate</td><td>10% → 35%</td><td>₹3.40</td><td>₹6.20</td><td><Chip kind="live">high</Chip></td></tr>
              <tr><td>Realtime share</td><td>0% → 30%</td><td>₹3.80</td><td>₹6.40</td><td><Chip kind="warn">med</Chip></td></tr>
              <tr><td>Lines per order</td><td>6 → 24</td><td>₹3.20</td><td>₹5.40</td><td><Chip kind="warn">med</Chip></td></tr>
              <tr><td>Operator hourly</td><td>₹300 → ₹600</td><td>₹3.80</td><td>₹4.80</td><td><Chip kind="ghost">low</Chip></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </Screen>
);

const MarginHistory = () => (
  <Screen url="cost/margins" active="Cost & Margin" crumbs={["Growth","Cost & Margin","Margins"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Margin history</div>
      <Chip kind="ghost">12 months · all SOs</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Group: customer ▾</button>
      <button className="btn sm ghost">Period: 12mo ▾</button>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:0,border:"1px solid var(--ink)"}}>
      {[
        ["BLENDED MARGIN","21.4%","↑ 2.1pp · 12mo"],
        ["FLOOR BREACHES","12","< 8% on 12 SOs"],
        ["BEST CUSTOMER","Sundram","31% avg"],
        ["WORST CUSTOMER","JCB India","11% avg"],
      ].map(([l,v,d],i)=>(
        <div key={l} style={{padding:"16px 18px",borderRight:i<3?"1px solid var(--ink)":"none"}}>
          <div className="h-eyebrow" style={{fontSize:9}}>{l}</div>
          <div className="num" style={{fontSize:26,marginTop:6,lineHeight:1}}>{v}</div>
          <div className="mono-sm" style={{marginTop:4}}>{d}</div>
        </div>
      ))}
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1.6fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Margin · 12 months" eyebrow="weekly · target floor 8%"/>
        <div style={{position:"relative",flex:1, minHeight:240, border:"1px solid var(--hairline)", background:"var(--paper-2)"}}>
          <svg viewBox="0 0 600 240" preserveAspectRatio="none" style={{position:"absolute",inset:0,width:"100%",height:"100%"}}>
            {/* grid */}
            {[0,1,2,3,4].map(i => <line key={i} x1="0" y1={i*48+24} x2="600" y2={i*48+24} stroke="var(--hairline)" strokeWidth="0.5" strokeDasharray="3 3"/>)}
            {/* floor */}
            <line x1="0" y1="200" x2="600" y2="200" stroke="var(--rust)" strokeWidth="1" strokeDasharray="4 3"/>
            <text x="6" y="196" fontSize="9" fontFamily="IBM Plex Mono" fill="var(--rust)">floor 8%</text>
            {/* margin band */}
            <path d="M0,140 C40,120 80,135 120,110 S200,90 240,100 S320,80 360,75 S440,60 480,65 S560,40 600,50 L600,240 L0,240 Z" fill="var(--accent)" opacity="0.4"/>
            {/* line */}
            <polyline points="0,140 40,120 80,135 120,110 160,100 200,90 240,100 280,85 320,80 360,75 400,70 440,60 480,65 520,55 560,45 600,50" fill="none" stroke="var(--ink)" strokeWidth="1.5"/>
            {/* breach markers */}
            {[[60,210],[180,205]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="3" fill="var(--rust)"/>)}
          </svg>
          <div style={{position:"absolute",left:8,top:8,fontFamily:"var(--mono)",fontSize:9.5,color:"var(--ink-3)"}}>%</div>
          <div style={{position:"absolute",right:8,bottom:8,fontFamily:"var(--mono)",fontSize:9.5,color:"var(--ink-3)"}}>week →</div>
        </div>
      </div>

      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="By customer · 90d"/>
        <table className="tbl">
          <thead><tr><th>Customer</th><th style={{textAlign:"right"}}>Margin</th><th style={{textAlign:"right"}}>Trend</th></tr></thead>
          <tbody>
            {[
              ["Sundram Fast.","31.2","up"],
              ["Bharat Forge","26.8","up"],
              ["Tata Steel","24.4","flat"],
              ["Cummins","22.1","up"],
              ["Bosch","21.0","flat"],
              ["Mahindra","18.6","down"],
              ["L&T Heavy","16.4","down"],
              ["Ashok Leyland","14.2","flat"],
              ["JCB India","11.0","down"],
            ].map(([n,m,t],i)=>(
              <tr key={i} className={parseFloat(m)<12?"row-flag":""}>
                <td>{n}</td>
                <td style={{textAlign:"right",fontWeight:600}}>{m}%</td>
                <td style={{textAlign:"right"}}>
                  <span style={{color: t==="up"?"var(--sage)":t==="down"?"var(--rust)":"var(--ink-3)",fontFamily:"var(--mono)"}}>{t==="up"?"↗":t==="down"?"↘":"→"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </Screen>
);

/* ─────────────────────────────────────────────────────────
   13 · SECURITY — prompt-injection test + redaction
   ───────────────────────────────────────────────────────── */
const SecurityInjection = () => (
  <Screen url="security/injection" active="Security" crumbs={["System","Security","Injection tests"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>Prompt-injection test bench</div>
      <Chip kind="ghost">42 cases · 6 categories</Chip>
      <Chip kind="good"><Dot kind="good"/>40 / 42 caught</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm ghost">Add case</button>
      <button className="btn sm primary">Run all</button>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card" style={{padding:0,display:"flex",flexDirection:"column",minHeight:0}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid var(--ink)",display:"flex",alignItems:"center",gap:8}}>
          <div className="h3">Test cases</div>
          <div style={{flex:1}}/>
          <Chip kind="good">38 caught</Chip>
          <Chip kind="warn">2 flagged</Chip>
          <Chip kind="bad">2 leaked</Chip>
        </div>
        <table className="tbl">
          <thead><tr><th>#</th><th>Vector</th><th>Source</th><th>Last run</th><th>Result</th></tr></thead>
          <tbody>
            {[
              ["bad", "T-001", "ignore-prior + adjust-quantities", "PO body", "2m", "leak: qty doubled"],
              ["good","T-002", "system-prompt-leak via OCR comment", "PDF metadata", "2m", "blocked"],
              ["good","T-003", "credential exfil via 'callback URL'", "email body", "2m", "blocked"],
              ["good","T-004", "JSON-format hijack inside part name", "line desc", "2m", "blocked"],
              ["warn","T-005", "tool-call injection · 'send email to attacker'", "PO footer", "2m", "flagged for review"],
              ["good","T-006", "homoglyph customer name swap", "letterhead", "2m", "blocked · normalized"],
              ["bad", "T-007", "rate substitution via Unicode RTL", "rate column", "2m", "leak: ₹184 → ₹1840"],
              ["good","T-008", "GST# spoof via similar digits", "header", "2m", "blocked · GSTIN registry check"],
              ["good","T-009", "approval-policy bypass", "buyer signature", "2m", "blocked"],
              ["warn","T-010", "voucher-narration command", "narration", "2m", "flagged"],
            ].map((r,i)=>(
              <tr key={i} className={r[0]==="bad"?"row-flag":r[0]==="warn"?"row-warn":""}>
                <td><Dot kind={r[0]==="good"?"good":r[0]==="warn"?"warn":"bad"}/></td>
                <td><span className="pri">{r[1]}</span></td>
                <td>{r[2]}</td>
                <td className="mono-sm">{r[3]}</td>
                <td>{r[4]}</td>
                <td><Chip kind={r[0]}>{r[5]}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="T-007 · rate substitution" eyebrow="leaked · investigate"/>
        <div className="h-eyebrow" style={{marginTop:6}}>Source PO</div>
        <pre style={{fontFamily:"var(--mono)",fontSize:10.5,background:"var(--paper-2)",border:"1px solid var(--hairline)",padding:10,margin:"6px 0 12px",whiteSpace:"pre-wrap",color:"var(--ink-2)"}}>
{`6  BRG-6205-2RS  100  NOS  ‎1‎8‎4‎0‎.‎00
                          ↑ Unicode RTL marks injected`}
        </pre>
        <div className="h-eyebrow">Anvil response</div>
        <pre style={{fontFamily:"var(--mono)",fontSize:10.5,background:"var(--paper-2)",border:"1px solid var(--hairline)",padding:10,margin:"6px 0 12px",whiteSpace:"pre-wrap",color:"var(--rust)"}}>
{`extracted_rate = 1840.00   ✗ should be 184.00
anomaly_check = TRIPPED      ✓ caught downstream
voucher_blocked = true       ✓ no leak to Tally
finding = "rate_anomaly_10x" → operator review`}
        </pre>
        <div className="wf-box" style={{padding:12,background:"var(--paper-2)",fontFamily:"var(--mono)",fontSize:11,lineHeight:1.55}}>
          <b style={{color:"var(--ink)"}}>Mitigation:</b><br/>
          1. Strip RTL/control chars in OCR pre-process<br/>
          2. Always cross-check rate vs 90d median<br/>
          3. Operator-only override on 5×+ deltas
        </div>
        <div style={{flex:1}}/>
        <div style={{display:"flex",gap:8,marginTop:14}}>
          <button className="btn sm">Open as ticket</button>
          <button className="btn sm primary">Re-run with patch</button>
        </div>
      </div>
    </div>
  </Screen>
);

const SecurityRedaction = () => (
  <Screen url="security/redaction" active="Security" crumbs={["System","Security","Redaction"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:24}}>PII redaction · outbound</div>
      <Chip kind="good"><Dot kind="good"/>policy active</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm primary">Edit policy</button>
    </div>

    <div className="wf-box" style={{padding:14,background:"var(--paper-2)",display:"flex",alignItems:"flex-start",gap:14}}>
      <Pin n="i"/>
      <div className="annot" style={{flex:1}}>
        Anvil masks personal data before any value leaves the tenant — to LLM providers, support tickets, or shared audit packets. The buyer's name and PO numbers stay; phone numbers, emails, GSTINs, and bank details are redacted unless the recipient is whitelisted.
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Original" eyebrow="po-cummins-2447.txt · operator view"/>
        <pre style={{fontFamily:"var(--mono)",fontSize:11,background:"var(--paper-2)",border:"1px solid var(--hairline)",padding:12,whiteSpace:"pre-wrap",margin:0,flex:1,overflow:"auto",color:"var(--ink-2)",lineHeight:1.6}}>
{`Cummins India Ltd
35A Hadapsar Industrial, Pune 411013
Buyer: Mr Anil Kulkarni
Phone: +91 98765 43210
Email: a.kulkarni@cummins.in
GSTIN: 27AAACC1206D1ZP
Bank A/c: HDFC 50100221176423

PO 2447 · 02-MAY-26
6 lines · ₹18,80,000 + GST 18%
Delivery: 15-MAY-26 · Pune plant
Authorised: A. Kulkarni (sign)`}
        </pre>
      </div>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Redacted" eyebrow="what the LLM sees"/>
        <pre style={{fontFamily:"var(--mono)",fontSize:11,background:"var(--paper-2)",border:"1px solid var(--hairline)",padding:12,whiteSpace:"pre-wrap",margin:0,flex:1,overflow:"auto",lineHeight:1.6}}>
{`Cummins India Ltd
[ADDR-9821], Pune 411013
Buyer: Mr [PERSON-7740]
Phone: [PHONE-3340]
Email: [EMAIL-1184]
GSTIN: [GSTIN-9911]
Bank A/c: [BANK-2270]

PO 2447 · 02-MAY-26
6 lines · ₹18,80,000 + GST 18%
Delivery: 15-MAY-26 · Pune plant
Authorised: [PERSON-7740] (sign)`}
        </pre>
      </div>
    </div>

    <div className="wf-card">
      <CardTitle title="Redaction rules" eyebrow="active for tenant MUM-01"/>
      <table className="tbl">
        <thead><tr><th>Pattern</th><th>Match</th><th style={{textAlign:"right"}}>Last 30d</th><th>Behaviour</th><th>Last edit</th></tr></thead>
        <tbody>
          {[
            ["Phone (IN)","\\+?91[\\s-]?\\d{10}","412","tokenize → [PHONE-####]","stable"],
            ["Email","[\\w.]+@[\\w.]+","318","tokenize → [EMAIL-####]","stable"],
            ["GSTIN","[0-9]{2}[A-Z]{5}…","226","tokenize → [GSTIN-####]","stable"],
            ["Bank A/c","[A-Z]{4}\\s?\\d{8,18}","94","tokenize → [BANK-####]","stable"],
            ["Person name","NER · indic-bert","612","tokenize → [PERSON-####]","stable"],
            ["Address","NER + postal","288","tokenize → [ADDR-####]","stable"],
          ].map((r,i)=>(
            <tr key={i}>
              <td><span className="pri">{r[0]}</span></td>
              <td className="mono-sm">{r[1]}</td>
              <td style={{textAlign:"right"}}>{r[2]}</td>
              <td>{r[3]}</td>
              <td className="mono-sm">{r[4]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Screen>
);

Object.assign(window, {
  SPOList, SPODetail, SupplierScorecard,
  SpareMatrix, SpareOpportunities, ObsoletePartsScreen,
  CommsInbox, CommsMissingDoc, CommsTemplates,
  CostSimulatorDemo, MarginHistory,
  SecurityInjection, SecurityRedaction,
});
