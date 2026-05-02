/* SECTION 05/06/07 — Customers, Aliases, Inventory, BOM, Quality */

const Customers = () => (
  <Screen url="anvil.app/customers" active="Customers" crumbs={["Anvil","Customers"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">Customers</div><Chip>47 active</Chip>
      <div style={{flex:1}}/>
      <input className="input" placeholder="⌕ name, GSTIN, ledger…" style={{width:280}}/>
      <button className="btn primary sm">+ New customer</button>
    </div>
    <div className="wf-card" style={{flex:1,padding:0,overflow:"hidden"}}>
      <table className="tbl">
        <thead><tr><th>Customer</th><th>GSTIN</th><th>Ledger</th><th>Profile</th><th>Orders</th><th>Last PO</th><th>Reuse</th><th>Path</th></tr></thead>
        <tbody>
          {[
            ["Tata Steel · JSR","20AAACT2727Q1Z2","Tata Steel - JSR","extractor-ready",112,"12m ago","94%","deterministic"],
            ["Bosch · BLR","29AAACB1534Q1ZN","Bosch India","stable",78,"2h","88%","deterministic"],
            ["Mahindra · NSK","27AAACM6094Q1Z9","Mahindra Auto","new",2,"1h","—","visual_pdf_or_ai"],
            ["L&T Heavy","27AAACL0140P1ZS","L&T Powai","changed",24,"3h","42%","manual_review"],
            ["Cummins India","27AAACC1206D1ZP","Cummins Pune","stable",36,"1d","92%","deterministic"],
          ].map((r,i) => (
            <tr key={i}><td><b>{r[0]}</b></td><td>{r[1]}</td><td>{r[2]}</td>
              <td><Chip kind={r[3]==="extractor-ready"?"good":r[3]==="changed"?"bad":r[3]==="new"?"warn":""}>{r[3]}</Chip></td>
              <td>{r[4]}</td><td>{r[5]}</td><td>{r[6]}</td><td className="mono-sm">{r[7]}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </Screen>
);

const CustomerProfile = () => (
  <Screen url="anvil.app/customers/tata-steel-jsr" active="Customers" crumbs={["Anvil","Customers","Tata Steel · JSR"]}>
    <div style={{display:"flex",alignItems:"baseline",gap:14}}>
      <div className="h1" style={{fontSize:28}}>Tata Steel · Jamshedpur</div>
      <Chip kind="good">● extractor-ready</Chip>
      <Chip kind="accent">★ trusted</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm">Export recipe.json</button>
      <button className="btn sm">Pin format ★</button>
      <button className="btn primary sm">+ New SO</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr",gap:12,flex:1,minHeight:0}}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <div className="wf-card">
          <CardTitle title="Identity"/>
          <table className="tbl"><tbody>
            {[["GSTIN","20AAACT2727Q1Z2"],["Ledger","Tata Steel - JSR"],["State","Jharkhand · interstate"],["Currency","INR"],["Payment terms","Net-45"],["Credit limit","₹ 12L"]].map(([k,v])=><tr key={k}><td style={{color:"var(--ink-3)"}}>{k}</td><td><b>{v}</b></td></tr>)}
          </tbody></table>
        </div>
        <div className="wf-card">
          <CardTitle title="Format profile · v4"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontFamily:"var(--mono)",fontSize:11.5}}>
            <div>Stability</div><div><b>stable</b> · 12 orders</div>
            <div>Layout fingerprint</div><div>2 cols · header @ y=40</div>
            <div>Last change</div><div>none in 90d</div>
            <div>Reuse score</div><div><b>94%</b></div>
            <div>Backend path</div><div>deterministic_text_extraction</div>
          </div>
          <div className="wf-divider" style={{margin:"10px 0"}}/>
          <div className="h-eyebrow">Profile versions</div>
          <div className="mono-sm" style={{marginTop:4}}>v4 · current · 02-Apr-26 · KP<br/>v3 · 14-Feb-26<br/>v2 · 09-Dec-25</div>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12,minHeight:0}}>
        <div className="wf-card">
          <CardTitle title="Recent orders" right={<span className="mono-sm">112 total</span>}/>
          <table className="tbl">
            <thead><tr><th>SO</th><th>PO</th><th>Lines</th><th>Value</th><th>State</th><th>Date</th></tr></thead>
            <tbody>
              {["SO-1042","SO-1029","SO-1018","SO-0996","SO-0982"].map((s,i)=>(
                <tr key={s}><td><b>{s}</b></td><td>PO-{2456-i*8}</td><td>{18-i*2}</td><td>₹ {(6.2-i*0.4).toFixed(1)}L</td>
                  <td><Chip kind={i?"good":""}>{i?"done":"extracted"}</Chip></td><td>{i===0?"today":i+"d ago"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="wf-card" style={{flex:1}}>
          <CardTitle title="Volume × value"/>
          <Bars data={[30,55,40,70,50,90,65,80,42,60,35,75]} accentAt={5}/>
        </div>
      </div>
    </div>
  </Screen>
);

const Aliases = () => (
  <Screen url="anvil.app/aliases" active="Part Aliases" crumbs={["Anvil","Part Aliases"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">Part aliases</div><Chip>1,820 mapped</Chip><Chip kind="warn">14 pending</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm">Import CSV</button><button className="btn primary sm">+ Map alias</button>
    </div>
    <div className="wf-card" style={{flex:1,padding:0,overflow:"hidden"}}>
      <table className="tbl">
        <thead><tr><th>Customer</th><th>Their description</th><th>Anvil SKU</th><th>Confidence</th><th>Hits</th><th>By</th><th>Updated</th><th></th></tr></thead>
        <tbody>
          {[
            ["Tata Steel","BRG-6204-2RS Bearing","BR-6204-ZZ","98%",47,"KP","12d",""],
            ["Bosch","Oil seal 25 x 42 x 7","OS-25-42-7","96%",18,"auto","3d",""],
            ["Mahindra","circlip int. 22","CL-INT-22","94%",22,"RM","8h",""],
            ["L&T","GREASE NIPPLE M6","?","—",0,"—","just now","map"],
            ["Cummins","FLANGE-BRG UCFL204","UCFL-204","82%",6,"KP","1h","review"],
          ].map((r,i)=>(
            <tr key={i}><td>{r[0]}</td><td><b>{r[1]}</b></td>
              <td>{r[2]==="?"?<Chip kind="bad">unmapped</Chip>:<b>{r[2]}</b>}</td>
              <td>{r[3]}</td><td>{r[4]}</td><td>{r[5]}</td><td>{r[6]}</td>
              <td>{r[7]==="map"?<button className="btn sm primary">Map →</button>:r[7]==="review"?<button className="btn sm">Review</button>:""}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </Screen>
);

const Inventory = () => (
  <Screen url="anvil.app/inventory" active="Inventory" crumbs={["Anvil","Inventory"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">Inventory · availability</div>
      <Chip>4,312 SKUs</Chip><Chip kind="warn">28 below MOQ</Chip><Chip kind="bad">6 OOS</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm">Sync from Tally</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
      {[["On hand","12,440","NOS"],["Allocated","3,108","to 18 SOs"],["Available","9,332","sellable"],["Last sync","00:14","02-May 09:14"]].map((s,i)=>(
        <div key={i} className="wf-card"><div className="h-eyebrow">{s[0]}</div><div style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:28,marginTop:4}}>{s[1]}</div><div className="mono-sm" style={{marginTop:2}}>{s[2]}</div></div>
      ))}
    </div>
    <div className="wf-card" style={{flex:1,padding:0,overflow:"hidden"}}>
      <table className="tbl">
        <thead><tr><th>SKU</th><th>Description</th><th>On hand</th><th>Alloc.</th><th>Avail.</th><th>Lead</th><th>MOQ</th><th>Last sale</th><th>Status</th></tr></thead>
        <tbody>
          {[
            ["BR-6204-ZZ","6204 ZZ bearing",1240,400,840,"4d",100,"today","ok"],
            ["OS-25-42-7","Oil seal",2200,250,1950,"7d",250,"today","ok"],
            ["UCFL-204","Flange UCFL-204",80,40,40,"14d",40,"3d","low"],
            ["BR-6205-ZZ","6205 ZZ bearing",0,0,0,"21d",100,"5d","oos"],
            ["CL-INT-22","Circlip int 22",640,500,140,"4d",500,"today","low"],
          ].map((r,i)=>(
            <tr key={i}><td><b>{r[0]}</b></td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td><td><b>{r[4]}</b></td><td>{r[5]}</td><td>{r[6]}</td><td>{r[7]}</td>
              <td><Chip kind={r[8]==="ok"?"good":r[8]==="oos"?"bad":"warn"}>{r[8].toUpperCase()}</Chip></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </Screen>
);

const BOM = () => (
  <Screen url="anvil.app/bom" active="BOM" crumbs={["Anvil","BOM"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">Bill of materials</div>
      <select className="select" style={{width:280}}><option>UCFL-204 · Flange bearing assy</option></select>
      <Chip>v3 · 12-Apr-26</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm">Compare versions</button>
      <button className="btn sm">Export CSV</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1.6fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card">
        <CardTitle title="Tree"/>
        <pre style={{fontFamily:"var(--mono)",fontSize:11.5,lineHeight:1.6,margin:0,whiteSpace:"pre"}}>
{`UCFL-204  Flange bearing assy
├── BR-6204-ZZ      bearing      ×1
├── HSG-FL-204      housing      ×1
│   ├── CST-FL-204A   casting      ×1
│   └── PNT-BLK-MATTE paint        0.04 L
├── BLT-M8x20        bolt M8×20   ×4
├── NUT-M8           nut M8       ×4
└── GRSE-NIP-M6      grease nip   ×1`}
        </pre>
      </div>
      <div className="wf-card" style={{display:"flex",flexDirection:"column"}}>
        <CardTitle title="Components & cost roll-up"/>
        <table className="tbl">
          <thead><tr><th>Component</th><th>Qty</th><th>UOM</th><th>Rate</th><th>Ext.</th><th>Stock</th><th>Risk</th></tr></thead>
          <tbody>
            {[["BR-6204-ZZ","1","NOS","184.00","184.00","840","ok"],
              ["HSG-FL-204","1","NOS","320.00","320.00","220","ok"],
              ["CST-FL-204A","1","NOS","210.00","210.00","60","low"],
              ["PNT-BLK-MATTE","0.04","L","640.00","25.60","18 L","ok"],
              ["BLT-M8x20","4","NOS","2.40","9.60","6,200","ok"],
              ["NUT-M8","4","NOS","1.10","4.40","8,400","ok"],
              ["GRSE-NIP-M6","1","NOS","8.50","8.50","0","oos"]].map((r,i)=>(
              <tr key={i}><td><b>{r[0]}</b></td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td><td><b>{r[4]}</b></td><td>{r[5]}</td>
                <td><Chip kind={r[6]==="ok"?"good":r[6]==="oos"?"bad":"warn"}>{r[6]}</Chip></td></tr>
            ))}
          </tbody>
        </table>
        <div style={{marginTop:"auto",borderTop:"2px solid var(--rule)",paddingTop:10,display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
          <span className="mono-sm">Material cost / unit</span>
          <span style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:24}}>₹ 762.10</span>
        </div>
      </div>
    </div>
  </Screen>
);

/* SECTION 07 — Quality (findings, anomalies, duplicates) */

const Findings = () => (
  <Screen url="anvil.app/findings" active="Findings" crumbs={["Anvil","Quality","Findings"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">Findings</div>
      <Chip kind="bad">3 high</Chip><Chip kind="warn">11 med</Chip><Chip>22 low</Chip>
      <div style={{flex:1}}/>
      <select className="select" style={{width:160}}><option>All severities</option></select>
      <select className="select" style={{width:160}}><option>Last 7 days</option></select>
    </div>
    <div className="wf-card" style={{flex:1,padding:0,overflow:"hidden"}}>
      <table className="tbl">
        <thead><tr><th>Sev</th><th>Type</th><th>SO</th><th>Line</th><th>Description</th><th>Detected</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {[
            ["high","rate-anomaly","SO-1042",6,"Rate ₹1,840 is 10× median for BR-6205-ZZ","12m","open"],
            ["high","duplicate-doc","SO-1041","—","Doc fingerprint matches SO-1041","1h","blocked"],
            ["high","credit-breach","SO-1029","—","Outstanding ₹14L > limit ₹12L","1d","escalated"],
            ["med","unmapped-part","SO-1042",5,"'GREASE NIPPLE M6' has no alias","12m","open"],
            ["med","low-confidence","SO-1039",4,"OCR 82% on 'UCFL-204'","3h","open"],
            ["med","price-mismatch","SO-1040",2,"₹22.50 vs quote ₹21.00 (1.4y old)","2h","accepted"],
            ["low","missing-uom","SO-1037",9,"UOM blank · defaulted NOS","1d","auto-resolved"],
          ].map((r,i)=>(
            <tr key={i}><td><Chip kind={r[0]==="high"?"bad":r[0]==="med"?"warn":""}>{r[0]}</Chip></td>
              <td className="mono">{r[1]}</td><td><b>{r[2]}</b></td><td>{r[3]}</td>
              <td>{r[4]}</td><td>{r[5]}</td><td>{r[6]}</td>
              <td><button className="btn sm">Open</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </Screen>
);

const Duplicates = () => (
  <Screen url="anvil.app/duplicates" active="Duplicates" crumbs={["Anvil","Quality","Duplicates"]}>
    <div className="h2">Duplicate / revision detection</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card">
        <CardTitle title="Candidate · PO-2455 vs SO-1041" right={<Chip kind="bad">96% match</Chip>}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,fontFamily:"var(--mono)",fontSize:11.5}}>
          <div className="wf-box"><div className="h-eyebrow">Incoming</div><div style={{marginTop:6}}>PO-2455 · 1.4 MB · 12 lines · ₹2.10L<br/>sha256 c4d…ab2</div></div>
          <div className="wf-box"><div className="h-eyebrow">Existing</div><div style={{marginTop:6}}>SO-1041 · 1h ago<br/>sha256 c4d…ab2</div></div>
        </div>
        <div className="wf-divider" style={{margin:"10px 0"}}/>
        <div className="mono-sm">Score breakdown</div>
        {[["fingerprint",100],["filename",95],["customer",100],["line-set",92],["totals",98]].map(([k,v])=>(
          <div key={k} style={{display:"grid",gridTemplateColumns:"100px 1fr 40px",gap:8,alignItems:"center",margin:"4px 0",fontFamily:"var(--mono)",fontSize:11}}>
            <span>{k}</span><div style={{height:8,background:"var(--paper-2)",border:"1.5px solid var(--rule)"}}><div style={{height:"100%",width:v+"%",background:"var(--accent)"}}/></div><b>{v}%</b>
          </div>
        ))}
        <div style={{display:"flex",gap:8,marginTop:14}}>
          <button className="btn sm primary">Treat as same</button>
          <button className="btn sm">Mark revision</button>
          <button className="btn sm">Force new</button>
        </div>
      </div>
      <div className="wf-card">
        <CardTitle title="Diff · line items"/>
        <table className="tbl">
          <thead><tr><th>Line</th><th>Field</th><th>SO-1041</th><th>PO-2455</th></tr></thead>
          <tbody>
            {[[3,"Qty","500","500"],[4,"Rate","612.00","612.00"],[6,"Rate","184.00","1840.00"],[7,"—","(none)","new line · WSHR-M8 ×40"]].map((r,i)=>(
              <tr key={i} style={{background:r[2]!==r[3]?"rgba(255,90,31,0.08)":""}}><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td><td><b>{r[3]}</b></td></tr>
            ))}
          </tbody>
        </table>
        <div className="mono-sm" style={{marginTop:8,color:"var(--ink-3)"}}>2 differences · suggests <b>revision</b> not duplicate.</div>
      </div>
    </div>
  </Screen>
);

Object.assign(window, { Customers, CustomerProfile, Aliases, Inventory, BOM, Findings, Duplicates });
