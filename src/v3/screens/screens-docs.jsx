/* SECTION 04 — Documents (upload, OCR review, library) */

const DocLibrary = () => (
  <Screen url="anvil.app/documents" active="Documents" crumbs={["Anvil","Documents"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">Document library</div><Chip>3,142 docs</Chip><Chip kind="warn">12 unprocessed</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm">Email-in address</button>
      <button className="btn primary sm">+ Upload</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
      {[["Inbox · 12","unprocessed"],["This week · 84","ingested"],["Bytes used · 1.2 GB","of 5"],["Auto-OCR ON","fallback manual"]].map((s,i) => (
        <div key={i} className="wf-card"><div className="h-eyebrow">{s[1]}</div><div style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:24,marginTop:4}}>{s[0]}</div></div>
      ))}
    </div>
    <div className="wf-card" style={{flex:1,padding:0,overflow:"hidden"}}>
      <table className="tbl">
        <thead><tr><th>Doc</th><th>Type</th><th>Customer</th><th>Source</th><th>OCR</th><th>Linked SO</th><th>Size</th><th>Uploaded</th></tr></thead>
        <tbody>
          {[
            ["po-tata-2456.pdf","PDF · PO","Tata Steel","email · sales@","94%","SO-1042","2.1 MB","12m"],
            ["price-comp-may.xlsx","XLSX · price","internal","upload","→ TSV","SO-1042","48 KB","12m"],
            ["po-mahindra.pdf","PDF · PO","Mahindra","email · po@","—","SO-1041","1.4 MB","1h"],
            ["scan-lt-rfq.jpg","IMG · RFQ","L&T","upload","82%","SO-1039","3.2 MB","3h"],
            ["bosch-amend-2.pdf","PDF · amend","Bosch","email","98%","SO-1040","780 KB","2h"],
            ["unknown-fax.pdf","PDF · ?","unknown","fax-bridge","41%","—","2.4 MB","1d"],
          ].map((r,i) => (
            <tr key={i}><td><b>{r[0]}</b></td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td>
              <td>{r[4]==="—"?<Chip>queued</Chip>:r[4]==="41%"?<Chip kind="bad">{r[4]}</Chip>:r[4]}</td>
              <td>{r[5]==="—"?<Chip kind="warn">unlinked</Chip>:<b>{r[5]}</b>}</td><td>{r[6]}</td><td>{r[7]}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  </Screen>
);

const DocOCR = () => (
  <Screen url="anvil.app/documents/po-tata-2456" active="Documents" crumbs={["Anvil","Documents","po-tata-2456.pdf"]}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div className="h2">po-tata-2456.pdf</div>
      <Chip kind="good">94% conf</Chip><Chip>4 pages</Chip><Chip>2.1 MB</Chip>
      <div style={{flex:1}}/>
      <button className="btn sm">Download</button><button className="btn sm">Re-OCR</button><button className="btn primary sm">Link to SO →</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"180px 1.4fr 1fr",gap:12,flex:1,minHeight:0}}>
      <div className="wf-card" style={{padding:8,display:"flex",flexDirection:"column",gap:8,overflow:"auto"}}>
        {[1,2,3,4].map(p => (
          <div key={p} style={{border:p===2?"3px solid var(--accent)":"2px solid var(--rule)"}}>
            <Ph label={"pg "+p} h={120}/>
          </div>
        ))}
      </div>
      <div className="wf-card" style={{padding:0,position:"relative"}}>
        <Ph label="page 2 · table region" h={500}/>
        {[[40,80,260,16],[40,110,260,16],[40,180,260,16],[40,210,260,16]].map((b,i) => (
          <div key={i} style={{position:"absolute",left:b[0],top:b[1],width:b[2],height:b[3],border:"2px solid var(--accent)",background:"rgba(255,90,31,0.10)"}}/>
        ))}
      </div>
      <div className="wf-card" style={{display:"flex",flexDirection:"column",minHeight:0}}>
        <CardTitle title="Extracted text · pg 2"/>
        <div style={{flex:1,overflow:"auto",fontFamily:"var(--mono)",fontSize:11,whiteSpace:"pre-wrap",lineHeight:1.6,background:"var(--paper-2)",padding:10,border:"2px solid var(--rule)"}}>
{`PURCHASE ORDER  PO-2456
TATA STEEL · Jamshedpur · GSTIN 20AAACT2727Q1Z2

LINE  PART                   QTY UOM   RATE
1     BRG-6204-2RS Bearing   100 NOS   184.00
2     OIL-SEAL-25x42x7       250 NOS    22.50
3     CIRCLIP INT 22mm       500 NOS     4.10
4     FLANGE-BRG UCFL204      40 NOS   612.00 ⚑low-conf
5     GREASE NIPPLE M6        60 NOS     8.50 ⚑new-part
6     BRG-6205-2RS           100 NOS  1840.00 ⚑anomaly`}
        </div>
        <div className="wf-divider" style={{margin:"10px 0"}}/>
        <div className="h-eyebrow">Provenance</div>
        <div className="mono-sm" style={{marginTop:4}}>doc-id 8a1f-… · sha256 c4d…ab2 · uploaded by sales-bot · email msg-id &lt;…&gt;</div>
      </div>
    </div>
  </Screen>
);

const DocUpload = () => (
  <Screen url="anvil.app/documents/upload" active="Documents" crumbs={["Anvil","Documents","Upload"]}>
    <div className="h2">Upload documents</div>
    <div className="wf-card" style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,padding:48,borderStyle:"dashed",borderWidth:3,borderColor:"var(--ink-3)"}}>
      <div style={{fontFamily:"var(--mono)",fontSize:48,lineHeight:1}}>↥</div>
      <div className="h2">Drop files here</div>
      <div className="mono-sm">PDF · JPG · PNG · XLSX · CSV · TSV · TXT &nbsp;·&nbsp; up to 25 MB each</div>
      <button className="btn primary">Browse files</button>
      <div className="mono-sm" style={{marginTop:14}}>or email to <b>ops+mum01@in.anvil.app</b> · or connect Drive / Outlook</div>
    </div>
    <div className="wf-card">
      <CardTitle title="In progress · 3"/>
      {[["po-cummins-887.pdf","upload","100%","Routing…"],["scan-lt-rfq.jpg","ocr","62%","Page 2 of 3"],["price-may.xlsx","convert","done","42 rows · TSV"]].map((r,i) => (
        <div key={i} style={{display:"grid",gridTemplateColumns:"1.5fr 100px 1fr 80px",gap:12,padding:"8px 0",borderBottom:"1px solid var(--hairline)",alignItems:"center",fontFamily:"var(--mono)",fontSize:11.5}}>
          <span><b>{r[0]}</b></span>
          <Chip>{r[1]}</Chip>
          <div style={{height:8,border:"1.5px solid var(--rule)",background:"var(--paper-2)"}}><div style={{height:"100%",width:r[2],background:r[2]==="done"?"var(--good)":"var(--ink)"}}/></div>
          <span style={{color:"var(--ink-3)"}}>{r[3]}</span>
        </div>
      ))}
    </div>
  </Screen>
);

Object.assign(window, { DocLibrary, DocOCR, DocUpload });
