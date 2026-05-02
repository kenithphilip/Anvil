/* SECTION 00 — COVER + BRAND SYSTEM
   Single 1280×1600 long-form artboard documenting the system. */

const CoverHero = () => (
  <div className="cover" style={{width:1280, minHeight:1700, background:"var(--paper)", position:"relative"}}>

    {/* ── Hero ───────────────────────────────────────────── */}
    <section style={{position:"relative", padding:"56px 64px 40px", borderBottom:"2px solid var(--ink)"}}>
      <div className="wf-grid" style={{position:"absolute",inset:0,opacity:0.5}}/>
      <div style={{position:"relative", display:"flex", alignItems:"flex-start", gap:32}}>
        <AnvilMark size={88} accent/>
        <div style={{flex:1}}>
          <div className="h-eyebrow">Anvil · Internal Tool · v0.2 · 02 May 2026</div>
          <div className="h-display" style={{marginTop:14, fontSize:88}}>
            Forge orders<br/>from chaos.
          </div>
          <div className="body" style={{marginTop:18, maxWidth:680, fontSize:15, lineHeight:1.5}}>
            Anvil is the sales-ops backbone for an Indian industrial-supplies firm — a layer that turns scanned customer POs, WhatsApp pricelists, and emailed RFQs into auditable Tally vouchers, with humans always in the loop. This deck documents the full surface: <b>54 screens</b> across <b>14 sections</b>, 3 directions for the headline views, and the brand language that ties them together.
          </div>
          <div style={{display:"flex", gap:8, marginTop:24, flexWrap:"wrap"}}>
            <Chip kind="fill">Sales-Ops</Chip>
            <Chip>OCR · LLM extract</Chip>
            <Chip>Tally bridge</Chip>
            <Chip>Audit-first</Chip>
            <Chip kind="live">Brand v0.2</Chip>
          </div>
        </div>
        <div style={{width:280, border:"1px solid var(--ink)", padding:14, fontFamily:"var(--mono)", fontSize:11, lineHeight:1.7}}>
          <div className="h-eyebrow" style={{marginBottom:8}}>Sheet 00 / 14</div>
          <div style={{display:"grid", gridTemplateColumns:"1fr auto", gap:"3px 12px"}}>
            <span style={{color:"var(--ink-3)"}}>Project</span><b>Anvil</b>
            <span style={{color:"var(--ink-3)"}}>Tenant</span><b>MUM-01</b>
            <span style={{color:"var(--ink-3)"}}>Owner</span><b>K. Philip</b>
            <span style={{color:"var(--ink-3)"}}>Reviewers</span><b>R. Iyer · A. Nair</b>
            <span style={{color:"var(--ink-3)"}}>Coords</span><b>72.83°E · 18.94°N</b>
            <span style={{color:"var(--ink-3)"}}>Status</span><b style={{color:"var(--accent-2)"}}>● IN REVIEW</b>
          </div>
        </div>
      </div>
      <span className="crosshair" style={{top:8,left:8}}/>
      <span className="crosshair" style={{top:8,right:8}}/>
      <span className="crosshair" style={{bottom:8,left:8}}/>
      <span className="crosshair" style={{bottom:8,right:8}}/>
    </section>

    {/* ── TOC ────────────────────────────────────────────── */}
    <section style={{padding:"32px 64px", borderBottom:"1px solid var(--ink)"}}>
      <SectionHeader n={1} title="Contents" sub="The system as 14 sheets. Each section below maps to one cluster of screens on this canvas."/>
      <div style={{display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:"4px 48px", fontFamily:"var(--mono)", fontSize:12}}>
        {[
          ["00", "Cover & brand system", "1 sheet"],
          ["01", "Auth — magic link, tenant, errors", "5 screens"],
          ["02", "Ops Overview — 3 directions", "3 screens"],
          ["03", "Sales Order flow — capture → push", "9 screens"],
          ["04", "Documents — library, upload, OCR", "3 screens"],
          ["05", "Customers & Part Aliases", "3 screens"],
          ["06", "Inventory & BOM", "2 screens"],
          ["07", "Quality — findings, duplicates, eval", "3 screens"],
          ["08", "Source POs — supplier orders", "3 screens"],
          ["09", "Spare Matrix — recommendations", "3 screens"],
          ["10", "Communications — drafts & nudges", "3 screens"],
          ["11", "Tally — push, amend, reconcile", "3 screens"],
          ["12", "Cost — policy, simulator, margins", "3 screens"],
          ["13", "System — audit, settings, security, ⌘K", "4 screens"],
          ["14", "Mobile companion", "4 screens"],
          ["15", "States — empty, error, offline, dark", "3 screens"],
        ].map(([n,t,c]) => (
          <div key={n} style={{display:"flex", alignItems:"baseline", gap:12, borderBottom:"1px dashed var(--hairline)", padding:"7px 0"}}>
            <span style={{color:"var(--ink-4)", letterSpacing:"0.08em"}}>{n}</span>
            <span style={{flex:1, color:"var(--ink)", fontWeight:600, letterSpacing:"-0.005em", fontFamily:"var(--sans)", fontSize:13}}>{t}</span>
            <span style={{color:"var(--ink-3)"}}>{c}</span>
          </div>
        ))}
      </div>
    </section>

    {/* ── BRAND ──────────────────────────────────────────── */}
    <section style={{padding:"32px 64px", borderBottom:"1px solid var(--ink)"}}>
      <SectionHeader n={2} title="Brand" sub="Anvil is the place where soft inputs (a photo of a PO, a WhatsApp price list) get hammered into hard, auditable records. The visual language borrows from CAD drawings and process diagrams."/>

      {/* Logo lockups */}
      <div style={{display:"grid", gridTemplateColumns:"1.1fr 1fr 1fr", gap:0, border:"1px solid var(--ink)"}}>
        <div style={{padding:"32px 28px", borderRight:"1px solid var(--ink)", display:"flex", alignItems:"center", gap:18, minHeight:160}}>
          <AnvilMark size={56}/>
          <div>
            <div style={{fontFamily:"var(--sans)", fontWeight:800, fontSize:38, letterSpacing:"-0.025em", lineHeight:1}}>Anvil</div>
            <div className="mono-sm" style={{marginTop:4}}>Primary lockup</div>
          </div>
        </div>
        <div style={{padding:"32px 28px", borderRight:"1px solid var(--ink)", background:"var(--ink)", color:"var(--paper)", display:"flex", alignItems:"center", gap:18}}>
          <AnvilMark size={56} accent inverted/>
          <div>
            <div style={{fontFamily:"var(--sans)", fontWeight:800, fontSize:38, letterSpacing:"-0.025em", lineHeight:1}}>Anvil</div>
            <div className="mono-sm" style={{marginTop:4, color:"var(--paper)", opacity:0.7}}>Reverse · accent horn</div>
          </div>
        </div>
        <div style={{padding:"32px 28px", display:"flex", flexDirection:"column", gap:18, justifyContent:"center"}}>
          <div style={{display:"flex", alignItems:"center", gap:14}}>
            <AnvilMark size={32}/>
            <div style={{fontFamily:"var(--sans)", fontWeight:800, fontSize:22}}>Anvil</div>
            <div className="mono-sm">UI bar</div>
          </div>
          <div style={{display:"flex", alignItems:"center", gap:14}}>
            <AnvilMark size={20}/>
            <div style={{fontFamily:"var(--sans)", fontWeight:700, fontSize:14}}>Anvil</div>
            <div className="mono-sm">Inline / chip</div>
          </div>
          <div style={{display:"flex", alignItems:"center", gap:14}}>
            <AnvilMark size={14}/>
            <div className="mono-sm">favicon · 16px</div>
          </div>
        </div>
      </div>

      {/* Mark anatomy */}
      <div style={{display:"grid", gridTemplateColumns:"320px 1fr", gap:24, marginTop:20}}>
        <div className="wf-card" style={{padding:24}}>
          <CardTitle title="Mark anatomy" eyebrow="The horn points right"/>
          <div style={{display:"grid",placeItems:"center",padding:"12px 0"}}>
            <svg viewBox="0 0 200 200" width="240" height="240" fill="none">
              <circle cx="100" cy="100" r="86" stroke="var(--ink)" strokeWidth="0.5" strokeDasharray="2 3"/>
              <circle cx="100" cy="100" r="92" stroke="var(--ink)" strokeWidth="1.5"/>
              <path d="M55 88 L150 88 L138 110 L120 110 L120 138 L65 138 L65 118 L55 118 Z" fill="var(--accent)" stroke="var(--ink)" strokeWidth="1.5"/>
              <path d="M75 144 L120 144 M65 152 L130 152" stroke="var(--ink)" strokeWidth="2"/>
              {/* dimension lines */}
              <line x1="55" y1="170" x2="150" y2="170" stroke="var(--ink-3)" strokeWidth="0.5"/>
              <line x1="55" y1="166" x2="55" y2="174" stroke="var(--ink-3)" strokeWidth="0.5"/>
              <line x1="150" y1="166" x2="150" y2="174" stroke="var(--ink-3)" strokeWidth="0.5"/>
              <text x="102" y="183" fontSize="9" fontFamily="IBM Plex Mono" textAnchor="middle" fill="var(--ink-3)">95u face</text>
              {/* horn label */}
              <line x1="150" y1="88" x2="170" y2="78" stroke="var(--ink-3)" strokeWidth="0.5"/>
              <text x="172" y="76" fontSize="9" fontFamily="IBM Plex Mono" fill="var(--ink-3)">horn</text>
            </svg>
          </div>
        </div>
        <div style={{display:"flex", flexDirection:"column", gap:14}}>
          <div className="wf-card">
            <CardTitle title="Tone of voice" eyebrow="How Anvil writes"/>
            <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:0, fontSize:12, lineHeight:1.5}}>
              {[
                ["Plain","Workshop English. Active verbs.","\"Push 3 vouchers to Tally.\""],
                ["Honest","Confidence, not promises.","\"Extracted at 0.87 — please verify.\""],
                ["Auditable","Every claim links to a source.","\"Qty 240 (PO p2 · line 4)\""],
              ].map(([t,d,e],i)=>(
                <div key={t} style={{padding:14, borderRight:i<2?"1px solid var(--hairline)":"none"}}>
                  <div className="h3" style={{marginBottom:6}}>{t}</div>
                  <div className="body-sm" style={{color:"var(--ink-3)"}}>{d}</div>
                  <div className="mono-sm" style={{marginTop:10,color:"var(--ink)",borderLeft:"2px solid var(--accent)",paddingLeft:8}}>{e}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="wf-card">
            <CardTitle title="Don'ts"/>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:0,fontFamily:"var(--mono)",fontSize:11}}>
              {[
                ["× \"AI did the magic\"", "→ \"Extracted with 94% confidence\""],
                ["× Emoji in product copy", "→ Status chips & glyphs"],
                ["× Drop-shadow cards",   "→ Hairline rules, hatch fills"],
                ["× Decorative gradients", "→ One accent: chartreuse #C8FF2B"],
              ].map(([a,b],i)=>(
                <div key={i} style={{padding:"10px 12px", borderTop:i>1?"1px dashed var(--hairline)":"none", borderRight:i%2===0?"1px dashed var(--hairline)":"none"}}>
                  <div style={{color:"var(--rust)"}}>{a}</div>
                  <div style={{color:"var(--sage)"}}>{b}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>

    {/* ── COLOR ─────────────────────────────────────────── */}
    <section style={{padding:"32px 64px", borderBottom:"1px solid var(--ink)"}}>
      <SectionHeader n={3} title="Color" sub="A near-monochrome system, with one electric accent reserved for live or actionable values. Color carries semantic weight, not decoration."/>

      <div style={{display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:0, border:"1px solid var(--ink)"}}>
        {[
          ["Paper",   "#FAFAF7", "var(--paper)",   "Surface · primary"],
          ["Paper-2", "#F2F1EB", "var(--paper-2)", "Surface · sunk"],
          ["Hairline","#C9C6BC", "var(--hairline)","Rules · dividers"],
          ["Ink-3",   "#5A5955", "var(--ink-3)",   "Type · secondary"],
          ["Ink",     "#0A0A0A", "var(--ink)",     "Type · primary · borders"],
          ["Accent",  "#C8FF2B", "var(--accent)",  "Live data · only"],
        ].map(([n,h,c,d],i)=>(
          <div key={n} style={{borderRight:i<5?"1px solid var(--ink)":"none", display:"flex", flexDirection:"column"}}>
            <div style={{height:130, background:c, borderBottom:"1px solid var(--ink)", position:"relative"}}>
              <div style={{position:"absolute",bottom:8,left:8,fontFamily:"var(--mono)",fontSize:9,color: i>=4 && i!==5 ?"var(--paper)":"var(--ink)"}}>{h}</div>
            </div>
            <div style={{padding:"12px 14px"}}>
              <div className="h3" style={{marginBottom:4}}>{n}</div>
              <div className="mono-sm">{d}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:0, marginTop:12, border:"1px solid var(--ink)"}}>
        {[
          ["Sage",  "#5C7A3F", "var(--sage)",  "Pass · confirmed"],
          ["Rust",  "#B0421C", "var(--rust)",  "Block · failed"],
          ["Amber", "#C7861E", "var(--amber)", "Warn · needs review"],
          ["Lapis", "#2E4D7B", "var(--lapis)", "Info · neutral"],
        ].map(([n,h,c,d],i)=>(
          <div key={n} style={{borderRight:i<3?"1px solid var(--ink)":"none", display:"flex", alignItems:"center", gap:12, padding:14}}>
            <div style={{width:48, height:48, background:c, border:"1px solid var(--ink)"}}/>
            <div>
              <div style={{fontFamily:"var(--sans)",fontWeight:700,fontSize:13}}>{n}</div>
              <div className="mono-sm">{h} · {d}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="wf-box" style={{marginTop:16, padding:14, display:"flex", gap:14, alignItems:"flex-start"}}>
        <Pin n="!"/>
        <div className="annot" style={{flex:1}}>
          <b>Accent rule:</b> chartreuse <span className="mono">#C8FF2B</span> is reserved for <i>live data</i>, <i>the next action</i>, or <i>active selection</i>. If everything is highlighted, nothing is. Status colors (sage/rust/amber/lapis) are semantic — they carry meaning, not branding.
        </div>
      </div>
    </section>

    {/* ── TYPE ──────────────────────────────────────────── */}
    <section style={{padding:"32px 64px", borderBottom:"1px solid var(--ink)"}}>
      <SectionHeader n={4} title="Typography" sub="Two families. Inter Tight does the talking; IBM Plex Mono handles coordinates, IDs, and any value that needs to align in a column."/>

      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:24}}>
        <div className="wf-card">
          <CardTitle title="Inter Tight" eyebrow="Display & UI · 400 / 600 / 700 / 800"/>
          <div className="h-display" style={{fontSize:72, marginBottom:14}}>Forge<br/>orders.</div>
          <div className="h1" style={{fontSize:28, marginBottom:8}}>Push 3 vouchers to Tally</div>
          <div className="h2" style={{marginBottom:8}}>Section title · 20px / 600</div>
          <div className="h3" style={{marginBottom:8}}>EYEBROW · 13PX / 600 · 0.02EM</div>
          <div className="body" style={{marginBottom:6}}>Body 13/1.5 — for paragraph copy across the system. Designed for tight tracking on dense data screens.</div>
          <div className="body-sm">Body-sm 12/1.45 — captions, helper text.</div>
        </div>
        <div className="wf-card">
          <CardTitle title="IBM Plex Mono" eyebrow="Coords, IDs, values · 400 / 500 / 600"/>
          <div className="mono" style={{fontSize:28, lineHeight:1.1, marginBottom:14}}>PO-2456 · ₹6,21,400</div>
          <div className="mono" style={{fontSize:18, marginBottom:8}}>conf 0.94 · p2 · line 4</div>
          <div className="mono" style={{fontSize:13, marginBottom:8, color:"var(--ink-3)"}}>tally://voucher/V-8821</div>
          <div className="mono-sm" style={{marginBottom:6}}>02 May 2026 · 14:21:08 IST</div>
          <div style={{height:1, background:"var(--hairline)", margin:"12px 0"}}/>
          <div className="num" style={{fontSize:42, lineHeight:1}}>284 <small style={{fontSize:14,color:"var(--ink-3)"}}>orders MTD</small></div>
          <div className="mono-sm" style={{marginTop:6}}>tabular nums · feature settings: "tnum"</div>
        </div>
      </div>

      <div className="wf-box" style={{marginTop:14, padding:0, display:"grid", gridTemplateColumns:"repeat(6,1fr)"}}>
        {[
          ["display","64/0.92"],
          ["h1","32/1.05"],
          ["h2","20/1.15"],
          ["h3","13 caps"],
          ["body","13/1.5"],
          ["mono","12 mono"],
        ].map(([n,d],i)=>(
          <div key={n} style={{padding:"10px 14px", borderRight:i<5?"1px solid var(--hairline)":"none"}}>
            <div className="mono-sm" style={{marginBottom:4}}>{n}</div>
            <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--ink-2)"}}>{d}</div>
          </div>
        ))}
      </div>
    </section>

    {/* ── COMPONENTS ─────────────────────────────────────── */}
    <section style={{padding:"32px 64px", borderBottom:"1px solid var(--ink)"}}>
      <SectionHeader n={5} title="Components" sub="The atomic kit used across all 54 screens."/>

      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:14}}>
        {/* Buttons */}
        <div className="wf-card">
          <CardTitle title="Buttons & inputs"/>
          <div style={{display:"flex", flexWrap:"wrap", gap:8, marginBottom:12}}>
            <button className="btn primary">Push to Tally <span className="arrow">→</span></button>
            <button className="btn live">Approve & sign <span className="arrow">↵</span></button>
            <button className="btn">Save draft</button>
            <button className="btn ghost">Cancel</button>
            <button className="btn danger">Reject</button>
          </div>
          <div style={{display:"flex", gap:8, marginBottom:12}}>
            <button className="btn sm primary">+ New SO</button>
            <button className="btn sm">Filter ▾</button>
            <button className="btn sm ghost"><Ic name="download" size={11}/>Export</button>
          </div>
          <input className="input" placeholder="Search by PO #, customer, or part…" style={{marginBottom:8}}/>
          <select className="select"><option>State · all</option></select>
        </div>

        {/* Chips */}
        <div className="wf-card">
          <CardTitle title="Chips & status"/>
          <div style={{display:"flex", flexWrap:"wrap", gap:6, marginBottom:12}}>
            <Chip>extracted</Chip>
            <Chip kind="fill">drafted</Chip>
            <Chip kind="live">live</Chip>
            <Chip kind="good">validated</Chip>
            <Chip kind="warn">needs review</Chip>
            <Chip kind="bad">blocked</Chip>
            <Chip kind="info">queued</Chip>
            <Chip kind="ghost">archived</Chip>
          </div>
          <div style={{display:"flex", gap:14, alignItems:"center", marginBottom:8, fontFamily:"var(--mono)", fontSize:11}}>
            <span><Dot kind="live"/> live</span>
            <span><Dot kind="good"/> ok</span>
            <span><Dot kind="warn"/> warn</span>
            <span><Dot kind="bad"/> fail</span>
            <span><Dot kind="info"/> info</span>
            <span><Dot kind="muted"/> idle</span>
          </div>
          <div style={{display:"flex", gap:6, marginTop:10}}>
            <span className="sev-bar high"/><span className="mono-sm">severity high</span>
            <span className="sev-bar med" style={{marginLeft:10}}/><span className="mono-sm">med</span>
            <span className="sev-bar low" style={{marginLeft:10}}/><span className="mono-sm">low</span>
          </div>
        </div>

        {/* Stats */}
        <div className="wf-card">
          <CardTitle title="Stat blocks"/>
          <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14}}>
            <Stat v="284" l="Orders MTD" delta="↑ 14% w/w"/>
            <Stat v="₹4.20" l="Cost / SO" delta="↓ ₹1.80" kind=""/>
            <Stat v="3" l="Blocked" delta="2 high-value" kind="bad"/>
          </div>
          <div className="wf-divider" style={{margin:"14px 0"}}/>
          <div style={{display:"flex", gap:14, alignItems:"flex-end"}}>
            <Spark/>
            <div className="mono-sm">12d trend · throughput</div>
          </div>
        </div>

        {/* Steps */}
        <div className="wf-card">
          <CardTitle title="Process steps"/>
          <Steps items={["Capture","Preflight","Extract","Validate","Approve","Push"]} current={2}/>
          <div className="mono-sm" style={{marginTop:14}}>Active step gets the chartreuse underline.</div>
        </div>
      </div>

      {/* Iconography */}
      <div className="wf-card" style={{marginTop:14}}>
        <CardTitle title="Iconography" eyebrow="16px line · 1.25 stroke · square caps"/>
        <div style={{display:"grid", gridTemplateColumns:"repeat(8,1fr)", gap:0, border:"1px solid var(--hairline)"}}>
          {["overview","orders","spo","docs","inv","customer","alias","bom",
            "tally","findings","dup","audit","cost","spare","comm","eval",
            "sec","settings","cmd","plus","download","refresh","chevron","user"].map((n,i)=>(
            <div key={n} style={{padding:"14px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:6,borderRight:(i+1)%8?"1px dashed var(--hairline)":"none",borderBottom:i<16?"1px dashed var(--hairline)":"none"}}>
              <Ic name={n} size={20}/>
              <div className="mono-sm" style={{fontSize:9,letterSpacing:"0.04em"}}>{n}</div>
            </div>
          ))}
        </div>
      </div>
    </section>

    {/* ── PRINCIPLES ─────────────────────────────────────── */}
    <section style={{padding:"32px 64px 56px"}}>
      <SectionHeader n={6} title="Principles" sub="The five rules every Anvil screen is held to."/>
      <div style={{display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:0, border:"1px solid var(--ink)"}}>
        {[
          ["01","Provenance","Every value links to its source. No orphan numbers."],
          ["02","Confidence","Show the model's certainty. Never hide it behind a checkmark."],
          ["03","Reversibility","Nothing pushed without a way back. Drafts before vouchers."],
          ["04","Density","Workshop tools, not consumer apps. Show 14 rows, not 4."],
          ["05","Quiet by default","Color is information. Restraint makes the accent matter."],
        ].map(([n,t,d],i)=>(
          <div key={n} style={{padding:"22px 18px", borderRight:i<4?"1px solid var(--ink)":"none", display:"flex", flexDirection:"column", gap:10, minHeight:170}}>
            <div className="mono-sm" style={{fontSize:11, color:"var(--ink-3)"}}>{n}</div>
            <div className="h2">{t}</div>
            <div className="body-sm" style={{color:"var(--ink-3)"}}>{d}</div>
            <div style={{marginTop:"auto",height:4,background:i===0?"var(--accent)":"var(--ink)"}}/>
          </div>
        ))}
      </div>

      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginTop:48, paddingTop:18, borderTop:"1px solid var(--ink)"}}>
        <div className="mono-sm">— end of cover —</div>
        <div className="mono-sm">Anvil v0.2 · 2026-05-02 · K. Philip · sheet 00/14</div>
        <AnvilMark size={20}/>
      </div>
    </section>
  </div>
);

Object.assign(window, { CoverHero });
