/* SECTION 01 — Cover + Auth */

const Cover = () => (
  <div style={{width:1280,height:800,border:"5px solid var(--rule)",background:"var(--paper)",position:"relative",display:"flex",flexDirection:"column"}}>
    <div className="wf-stripe"></div>
    <div style={{flex:1,padding:"56px 64px 40px",display:"grid",gridTemplateColumns:"1.4fr 1fr",gap:48,alignItems:"end"}}>
      <div>
        <div className="h-eyebrow" style={{marginBottom:18}}>Wireframes · Vol. 01 · 2026-05-02</div>
        <div style={{fontFamily:"var(--sans)",fontWeight:900,fontSize:180,lineHeight:0.86,letterSpacing:"-0.04em"}}>
          ANVIL<span style={{color:"var(--accent)"}}>.</span>
        </div>
        <div className="body" style={{maxWidth:560,marginTop:18,fontSize:14}}>
          Sales-ops platform for industrial manufacturers. Ingest customer POs, extract line items with provenance, validate against masters, push to Tally — without losing the audit trail. Wireframe set covers the full surface area: auth, ops dashboards, document handling, SO agent flow, masters, quality, cost and audit.
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:18}}>
        <div className="wf-card" style={{padding:18}}>
          <div className="h-eyebrow">Manifest</div>
          <table style={{width:"100%",borderCollapse:"collapse",marginTop:8,fontFamily:"var(--mono)",fontSize:11.5}}>
            <tbody>
              {[
                ["Sections", "12"],
                ["Screens (desktop)", "38"],
                ["Screens (mobile)", "8"],
                ["Components", "24"],
                ["States covered", "Full incl. error/warn"],
                ["Fidelity", "Lo-fi → Mid-fi mix"],
                ["Roles", "SE · Mgr · Proc · Fin · Admin · Viewer"],
                ["Target host", "Vercel · Supabase"],
              ].map(([k,v]) => (
                <tr key={k}><td style={{padding:"3px 0",color:"var(--ink-3)"}}>{k}</td><td style={{padding:"3px 0",textAlign:"right",fontWeight:700}}>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="wf-card fill" style={{padding:18}}>
          <div className="h-eyebrow" style={{color:"var(--accent)"}}>Direction</div>
          <div style={{fontFamily:"var(--sans)",fontSize:18,fontWeight:700,marginTop:6,lineHeight:1.25}}>
            Brutalist. Monospace. Built for warehouses, not boardrooms.
          </div>
        </div>
      </div>
    </div>
    <div style={{borderTop:"3px solid var(--rule)",padding:"14px 64px",display:"flex",gap:40,fontFamily:"var(--mono)",fontSize:10.5,textTransform:"uppercase",letterSpacing:"0.12em",color:"var(--ink-3)"}}>
      <span>01 / Auth</span><span>02 / Overview</span><span>03 / Sales orders</span><span>04 / Documents</span><span>05 / Customers</span><span>06 / Inventory · BOM</span><span>07 / Quality</span><span>08 / Tally</span><span>09 / Cost</span><span>10 / Audit · Settings</span><span>11 / Mobile</span><span>12 / States</span>
    </div>
  </div>
);

/* AUTH 01 — Sign in */
const AuthSignIn = () => (
  <div className="wf-screen" style={{width:760,height:520}}>
    <Chrome url="anvil.app/sign-in" />
    <div style={{flex:1,display:"grid",gridTemplateColumns:"1fr 1fr"}}>
      <div style={{borderRight:"2px solid var(--rule)",padding:32,background:"var(--paper-2)",display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:24,height:24,background:"var(--ink)",position:"relative"}}>
              <div style={{position:"absolute",left:"50%",top:"50%",width:10,height:10,transform:"translate(-50%,-50%) rotate(45deg)",background:"var(--accent)"}}/>
            </div>
            <div style={{fontWeight:900,letterSpacing:"0.06em",fontSize:14,textTransform:"uppercase"}}>Anvil</div>
          </div>
          <div className="h1" style={{fontSize:42,marginTop:42,lineHeight:1}}>Sales ops, with receipts.</div>
          <div className="body" style={{marginTop:14,maxWidth:300}}>Customer POs in. Validated SOs out. Every field linked back to its source page and pixel.</div>
        </div>
        <div className="mono-sm">© 2026 ANVIL · v0.1</div>
      </div>
      <div style={{padding:32,display:"flex",flexDirection:"column",gap:14,justifyContent:"center"}}>
        <div className="h-eyebrow">Sign in</div>
        <div className="h2" style={{margin:"4px 0 14px"}}>Magic link · no passwords</div>
        <div>
          <label className="label">Work email</label>
          <input className="input" defaultValue="kenith@obara.in"/>
        </div>
        <div>
          <label className="label">Tenant</label>
          <select className="select"><option>obara · Mumbai-01 (default)</option></select>
        </div>
        <button className="btn primary lg" style={{justifyContent:"center"}}>Send magic link &nbsp; <span className="arrow">→</span></button>
        <div className="mono-sm" style={{textAlign:"center",marginTop:8}}>SSO · Google · Microsoft &nbsp;·&nbsp; <u>Use access token instead</u></div>
      </div>
    </div>
  </div>
);

/* AUTH 02 — Magic link sent */
const AuthSent = () => (
  <div className="wf-screen" style={{width:760,height:520}}>
    <Chrome url="anvil.app/sign-in/sent" />
    <div style={{flex:1,padding:48,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:18,textAlign:"center"}}>
      <div className="wf-box" style={{width:64,height:64,display:"grid",placeItems:"center",fontFamily:"var(--mono)",fontSize:24}}>✉</div>
      <div className="h2">Check your email</div>
      <div className="body" style={{maxWidth:380}}>We sent a one-time link to <b>kenith@obara.in</b>. It expires in 15 minutes. You can close this tab and click the link from any device.</div>
      <div style={{display:"flex",gap:10,marginTop:8}}>
        <button className="btn ghost sm">Resend in 0:42</button>
        <button className="btn sm">Use different email</button>
      </div>
      <div className="mono-sm" style={{marginTop:24,color:"var(--ink-4)"}}>Trouble? Check spam, or paste the access token directly →</div>
    </div>
  </div>
);

/* AUTH 03 — Callback / verifying */
const AuthCallback = () => (
  <div className="wf-screen" style={{width:760,height:520}}>
    <Chrome url="anvil.app/auth/callback?token=…" />
    <div style={{flex:1,padding:48,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
      <div className="h-eyebrow">Verifying</div>
      <div className="h2">Issuing session…</div>
      <div className="wf-box" style={{width:380,padding:0,marginTop:8}}>
        <div style={{height:14,background:"var(--ink)",width:"68%"}}></div>
      </div>
      <div className="mono-sm" style={{marginTop:8,maxWidth:380,textAlign:"center"}}>
        ✓ Token valid &nbsp; ✓ Tenant resolved &nbsp; <span style={{color:"var(--accent)"}}>… loading masters</span>
      </div>
    </div>
  </div>
);

/* AUTH 04 — Error */
const AuthError = () => (
  <div className="wf-screen" style={{width:760,height:520}}>
    <Chrome url="anvil.app/auth/callback" />
    <div style={{flex:1,padding:48,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
      <Chip kind="bad">● Link expired</Chip>
      <div className="h2" style={{marginTop:6}}>This link no longer works</div>
      <div className="body" style={{maxWidth:420,textAlign:"center"}}>Magic links expire after 15 minutes or after first use. Request a new one.</div>
      <div style={{display:"flex",gap:10,marginTop:10}}>
        <button className="btn primary sm">Send new link</button>
        <button className="btn sm">Contact admin</button>
      </div>
      <div className="mono-sm" style={{marginTop:30,color:"var(--ink-4)",borderTop:"1px solid var(--hairline)",paddingTop:14,width:380,textAlign:"center"}}>
        ERR_AUTH_EXPIRED · req_id 8c4f-a221-…
      </div>
    </div>
  </div>
);

/* AUTH 05 — Tenant picker (multi-tenant user) */
const AuthTenant = () => (
  <div className="wf-screen" style={{width:760,height:520}}>
    <Chrome url="anvil.app/select-tenant" />
    <div style={{flex:1,padding:36}}>
      <div className="h-eyebrow">Step 2 of 2</div>
      <div className="h2" style={{marginTop:6}}>Choose a workspace</div>
      <div className="body" style={{marginBottom:18}}>You belong to 3 tenants. Pick one to continue. You can switch later from the user menu.</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {[
          ["Obara · Mumbai-01", "admin", "1,284 orders · 47 customers", true],
          ["Obara · Pune-Plant", "manager", "612 orders · 23 customers", false],
          ["Acme Forging Ltd.", "viewer", "Read-only · 88 orders", false],
        ].map(([name, role, meta, current]) => (
          <div key={name} className="wf-box" style={{display:"flex",alignItems:"center",gap:14,cursor:"pointer",borderColor: current ? "var(--accent)" : "var(--rule)", borderWidth: current ? 3 : 2}}>
            <div style={{width:36,height:36,background:"var(--ink)",color:"var(--paper)",display:"grid",placeItems:"center",fontFamily:"var(--mono)",fontWeight:700}}>{name[0]}</div>
            <div style={{flex:1}}>
              <div style={{fontFamily:"var(--sans)",fontWeight:700,fontSize:14}}>{name}</div>
              <div className="mono-sm">{meta}</div>
            </div>
            <Chip kind={role==="admin" ? "accent" : role==="viewer" ? "" : "fill"}>{role}</Chip>
            <span className="mono">→</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

Object.assign(window, { Cover, AuthSignIn, AuthSent, AuthCallback, AuthError, AuthTenant });
