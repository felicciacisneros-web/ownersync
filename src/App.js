import React, { useState, useEffect } from "react";

const EXPENSE_CATEGORIES = [
  "Hot tub chemicals/Supplies/Care","Cleaning","Replacement Items",
  "Spring cleanup/reorganization","Lawn Care/Snow Removal",
  "Non-Covered Disposables","Handyman","Pest Control","Maintenance","HVAC",
];

const PROXY = "https://hostaway-proxy.vercel.app/api/proxy";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const LOGO_URL = "https://ownersync.vercel.app/logo2.jpg";

function AuthScreen({ onAuth }) {
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const handleConnect = async () => {
    if (!accountId || !apiKey) return setError("Please enter Account ID and API Key.");
    setLoading(true); setError("");
    try {
      const res = await fetch(`${PROXY}/v1/accessTokens`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: accountId, client_secret: apiKey, scope: "general" }),
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) throw new Error(data.message || "Authentication error");
      onAuth(data.access_token);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  const inp = { width:"100%", padding:"10px 14px", background:"#0f172a", border:"1px solid #334155", borderRadius:8, color:"#f1f5f9", fontSize:14, outline:"none", boxSizing:"border-box" };
  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg,#0f172a,#1e293b)", fontFamily:"Georgia,serif" }}>
      <div style={{ background:"#1e293b", border:"1px solid #334155", borderRadius:16, padding:"40px 48px", width:360, boxShadow:"0 25px 50px rgba(0,0,0,0.5)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"center", marginBottom:16 }}>
          <img src={LOGO_URL} alt="Logo" style={{ height:64, objectFit:"contain" }} />
        </div>
        <p style={{ color:"#64748b", fontSize:14, marginBottom:28, textAlign:"center" }}>Connect your Hostaway account to generate owner statements</p>
        <div style={{ marginBottom:16 }}><label style={{ display:"block", fontSize:12, color:"#94a3b8", marginBottom:6, textTransform:"uppercase" }}>Account ID</label><input style={inp} value={accountId} onChange={e=>setAccountId(e.target.value)} placeholder="123456"/></div>
        <div style={{ marginBottom:16 }}><label style={{ display:"block", fontSize:12, color:"#94a3b8", marginBottom:6, textTransform:"uppercase" }}>API Secret</label><input style={inp} type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="••••••••••••"/></div>
        {error && <p style={{ color:"#f87171", fontSize:13, marginBottom:12 }}>{error}</p>}
        <button style={{ width:"100%", padding:"12px", background:"#f59e0b", color:"#0f172a", border:"none", borderRadius:8, fontSize:15, fontWeight:"bold", cursor:"pointer" }} onClick={handleConnect} disabled={loading}>{loading?"Connecting...":"Connect →"}</button>
      </div>
    </div>
  );
}

function getChannel(r) {
  const s = (r.channelName || r.source || "").toLowerCase();
  if (s.includes("airbnb")) return "Airbnb";
  if (s.includes("vrbo") || s.includes("homeaway")) return "VRBO";
  return "Direct";
}

function getPMRate(r) {
  const nights = parseFloat(r.nights || 0);
  return nights >= 30 ? 0.15 : 0.25;
}

function StatementBuilder({ token }) {
  const [step, setStep] = useState("select");
  const [listings, setListings] = useState([]);
  const [selectedListing, setSelectedListing] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [midtermRevenue, setMidtermRevenue] = useState("");
  const [midtermNote, setMidtermNote] = useState("");
  const [platformFees, setPlatformFees] = useState({ airbnbHostFee:"", vrboFee:"", stripeFee:"", airbnbTax:"" });
  const [expenses, setExpenses] = useState(EXPENSE_CATEGORIES.map(cat=>({ category:cat, amount:"", note:"" })));
  const [extraExpenses, setExtraExpenses] = useState([]);
  const [view, setView] = useState("builder");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${PROXY}/v1/listings?limit=100`, { headers:{ Authorization:`Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message||"Error loading properties");
        setListings(data.result||[]);
      } catch(e){ setError(e.message); } finally { setLoading(false); }
    })();
  }, [token]);

  const fetchReservations = async () => {
    if (!selectedListing) return setError("Please select a property.");
    setLoading(true); setError("");
    try {
      const m = selectedMonth+1;
      const start = `${selectedYear}-${String(m).padStart(2,"0")}-01`;
      const end = `${selectedYear}-${String(m).padStart(2,"0")}-${new Date(selectedYear,m,0).getDate()}`;
      const res = await fetch(`${PROXY}/v1/reservations?listingId=${selectedListing.id}&startDate=${start}&endDate=${end}&limit=100`, { headers:{ Authorization:`Bearer ${token}` } });
      const resData = await res.json();
      if (!res.ok) throw new Error(resData.message||"Error loading reservations");
      const all = resData.result||[];
      const seen = new Set();
      const results = all.filter(r => {
        const payout = parseFloat(r.airbnbExpectedPayoutAmount||0);
        const arrival = (r.arrivalDate||"").substring(0,10);
        const status = (r.status||"").toLowerCase();
        const key = `${arrival}-${payout}`;
        if (payout > 0 && arrival >= start && arrival <= end && !seen.has(key) && status !== "cancelled" && status !== "canceled") {
          seen.add(key);
          return true;
        }
        return false;
      });
      setReservations(results);
      setStep("build");
    } catch(e){ setError(e.message); } finally { setLoading(false); }
  };

  // Group reservations by channel, tracking PM rate per reservation
  const revenueByChannel = reservations.reduce((acc, r) => {
    const ch = getChannel(r);
    const amt = parseFloat(r.airbnbExpectedPayoutAmount||0) + parseFloat(r.airbnbListingHostFee||0);
    const rate = getPMRate(r);
    if (!acc[ch]) acc[ch] = { amt: 0, pmTotal: 0 };
    acc[ch].amt += amt;
    acc[ch].pmTotal += amt * rate;
    return acc;
  }, {});

  const midtermAmt = parseFloat(midtermRevenue)||0;

  const grossRevenue = Object.values(revenueByChannel).reduce((s,v)=>s+v.amt,0) + midtermAmt;
  const af=parseFloat(platformFees.airbnbHostFee)||0, at=parseFloat(platformFees.airbnbTax)||0;
  const vf=parseFloat(platformFees.vrboFee)||0, sf=parseFloat(platformFees.stripeFee)||0;
  const totalPlatformFees=af+at+vf+sf;
  const totalRevenueReceived=grossRevenue-totalPlatformFees;

  // PM fees: per channel from Hostaway + midterm manual always 15%
  const pmRows = [
    ...Object.entries(revenueByChannel).map(([ch, {amt, pmTotal}]) => ({
      label: ch,
      amt,
      pmTotal,
      rate: Math.round((pmTotal / amt) * 100) || 25,
    })),
    ...(midtermAmt > 0 ? [{ label: "Other (Direct booking, Furnished Finder)", amt: midtermAmt, pmTotal: midtermAmt * 0.15, rate: 15 }] : []),
  ];

  const pmFee = pmRows.reduce((s,r)=>s+r.pmTotal, 0);
  const manualExp=expenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0)+extraExpenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const totalExpenses=manualExp+pmFee;
  const netRevenue=totalRevenueReceived-totalExpenses;
  const fmt=n=>"$"+Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",");
  const fmtS=n=>(n<0?"-":"")+"$"+Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",");

  const handleDownloadPDF = () => {
    const content = document.getElementById("statement-preview").innerHTML;
    const w = window.open("","_blank");
    w.document.write(`<!DOCTYPE html><html><head><title>Statement - ${selectedListing?.name} - ${MONTHS[selectedMonth]} ${selectedYear}</title><style>body{font-family:Georgia,serif;padding:40px;max-width:650px;margin:0 auto;color:#1e293b;}@media print{@page{margin:1cm;}}</style></head><body><div style="text-align:center;margin-bottom:24px;"><img src="${LOGO_URL}" style="height:80px;object-fit:contain;" /></div>${content}</body></html>`);
    w.document.close();
    setTimeout(()=>w.print(), 500);
  };

  const S={
    wrap:{minHeight:"100vh",background:"#0f172a",fontFamily:"Georgia,serif",color:"#e2e8f0"},
    hdr:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 24px",borderBottom:"1px solid #1e293b"},
    card:{background:"#1e293b",border:"1px solid #334155",borderRadius:12,padding:24,marginBottom:16},
    lbl:{display:"block",fontSize:12,color:"#94a3b8",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"},
    inpSm:{width:"100%",padding:"8px 10px",background:"#0f172a",border:"1px solid #334155",borderRadius:6,color:"#f1f5f9",fontSize:12,outline:"none",boxSizing:"border-box"},
    inpInline:{padding:"4px 6px",background:"#0f172a",border:"1px solid #334155",borderRadius:4,color:"#f1f5f9",fontSize:12,width:75,outline:"none"},
    sel:{width:"100%",padding:"10px 14px",background:"#0f172a",border:"1px solid #334155",borderRadius:8,color:"#f1f5f9",fontSize:14,outline:"none"},
    btnP:{width:"100%",padding:"12px",background:"#f59e0b",color:"#0f172a",border:"none",borderRadius:8,fontSize:15,fontWeight:"bold",cursor:"pointer",marginTop:8},
    btnO:{padding:"6px 14px",background:"transparent",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:13,cursor:"pointer"},
    btnG:{padding:"8px",background:"transparent",border:"1px dashed #334155",borderRadius:6,color:"#64748b",fontSize:13,cursor:"pointer",width:"100%",marginTop:8},
    tab:{padding:"6px 14px",background:"transparent",border:"1px solid #334155",borderRadius:6,color:"#64748b",fontSize:13,cursor:"pointer"},
    tabA:{padding:"6px 14px",background:"#f59e0b",border:"none",borderRadius:6,color:"#0f172a",fontSize:13,fontWeight:"bold",cursor:"pointer"},
    th:{color:"#64748b",fontWeight:"normal",fontSize:11,textTransform:"uppercase",padding:"4px 8px 8px",borderBottom:"1px solid #334155",textAlign:"left"},
    td:{padding:"7px 8px",borderBottom:"1px solid #1e293b",color:"#cbd5e1",verticalAlign:"middle"},
  };

  if (step==="select") return (
    <div style={S.wrap}>
      <div style={S.hdr}><div style={{display:"flex",alignItems:"center",gap:8}}><img src={LOGO_URL} alt="Logo" style={{height:36,objectFit:"contain"}}/></div></div>
      <div style={{padding:24,maxWidth:480}}>
        <div style={S.card}>
          <h2 style={{margin:"0 0 20px",fontSize:18,color:"#f1f5f9"}}>New Owner Statement</h2>
          {error&&<p style={{color:"#f87171",fontSize:13}}>{error}</p>}
          {loading&&<p style={{color:"#64748b",fontSize:13}}>Loading properties...</p>}
          <div style={{marginBottom:16}}><label style={S.lbl}>Property</label>
            <select style={S.sel} value={selectedListing?.id||""} onChange={e=>setSelectedListing(listings.find(x=>String(x.id)===e.target.value)||null)}>
              <option value="">Select a property...</option>
              {listings.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
            <div><label style={S.lbl}>Month</label><select style={S.sel} value={selectedMonth} onChange={e=>setSelectedMonth(Number(e.target.value))}>{MONTHS.map((m,i)=><option key={i} value={i}>{m}</option>)}</select></div>
            <div><label style={S.lbl}>Year</label><select style={S.sel} value={selectedYear} onChange={e=>setSelectedYear(Number(e.target.value))}>{[2023,2024,2025,2026].map(y=><option key={y} value={y}>{y}</option>)}</select></div>
          </div>
          <button style={S.btnP} onClick={fetchReservations} disabled={loading||!selectedListing}>{loading?"Loading...":"Load Reservations →"}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={S.wrap}>
      <div style={S.hdr}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><img src={LOGO_URL} alt="Logo" style={{height:36,objectFit:"contain"}}/></div>
        <div style={{display:"flex",gap:8}}>
          <button style={view==="builder"?S.tabA:S.tab} onClick={()=>setView("builder")}>Editor</button>
          <button style={view==="preview"?S.tabA:S.tab} onClick={()=>setView("preview")}>Preview</button>
          {view==="preview" && <button style={{...S.btnO, background:"#16a34a", color:"#fff", border:"none"}} onClick={handleDownloadPDF}>⬇ Download PDF</button>}
          <button style={S.btnO} onClick={()=>setStep("select")}>← Back</button>
        </div>
      </div>
      {view==="builder"?(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,padding:24}}>
          <div>
            <div style={S.card}>
              <h3 style={{margin:"0 0 4px",fontSize:13,color:"#94a3b8",textTransform:"uppercase"}}>Revenue</h3>
              <p style={{color:"#64748b",fontSize:12,margin:"0 0 16px"}}>{selectedListing?.name} · {MONTHS[selectedMonth]} {selectedYear}</p>
              {Object.keys(revenueByChannel).length===0?<p style={{color:"#64748b",fontSize:13}}>No reservations found.</p>:
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                  <thead><tr><th style={S.th}>Channel</th><th style={{...S.th,textAlign:"right"}}>Revenue</th><th style={{...S.th,textAlign:"right"}}>PM%</th></tr></thead>
                  <tbody>
                    {Object.entries(revenueByChannel).map(([ch,{amt,pmTotal}])=>(
                      <tr key={ch}>
                        <td style={S.td}>{ch}</td>
                        <td style={{...S.td,textAlign:"right"}}>{fmt(amt)}</td>
                        <td style={{...S.td,textAlign:"right",color:"#94a3b8"}}>{Math.round((pmTotal/amt)*100)||25}%</td>
                      </tr>
                    ))}
                    <tr style={{background:"#0f172a"}}><td style={S.td}><strong>Total Gross Revenue</strong></td><td style={{...S.td,textAlign:"right"}}><strong>{fmt(grossRevenue)}</strong></td><td style={S.td}></td></tr>
                  </tbody>
                </table>}
              <div style={{marginTop:16,paddingTop:16,borderTop:"1px solid #334155"}}>
                <label style={S.lbl}>Other (Direct booking, Furnished Finder) — always 15%</label>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <input style={S.inpSm} type="number" value={midtermRevenue} onChange={e=>setMidtermRevenue(e.target.value)} placeholder="0.00"/>
                  <input style={S.inpSm} value={midtermNote} onChange={e=>setMidtermNote(e.target.value)} placeholder="e.g. John Smith"/>
                </div>
                {midtermAmt > 0 && <p style={{color:"#64748b",fontSize:11,marginTop:6}}>PM Fee (15%): {fmt(midtermAmt*0.15)}</p>}
              </div>
            </div>
            <div style={S.card}>
              <h3 style={{margin:"0 0 16px",fontSize:13,color:"#94a3b8",textTransform:"uppercase"}}>Platform Fees</h3>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[["airbnbHostFee","Airbnb Host Fee"],["airbnbTax","Airbnb Occupancy Tax"],["vrboFee","VRBO Fee"],["stripeFee","Stripe Fee"]].map(([k,l])=>(
                  <div key={k}><label style={S.lbl}>{l}</label><input style={S.inpSm} type="number" value={platformFees[k]} onChange={e=>setPlatformFees(p=>({...p,[k]:e.target.value}))} placeholder="0.00"/></div>
                ))}
              </div>
              <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",fontSize:13,color:"#94a3b8",marginTop:8}}><span>Total Platform Fees</span><span style={{color:"#f87171"}}>-{fmt(totalPlatformFees)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",fontSize:13,borderTop:"2px solid #334155"}}><strong>Total Revenue Received</strong><strong>{fmt(totalRevenueReceived)}</strong></div>
            </div>
          </div>
          <div>
            <div style={S.card}>
              <h3 style={{margin:"0 0 16px",fontSize:13,color:"#94a3b8",textTransform:"uppercase"}}>Expenses</h3>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr><th style={S.th}>Category</th><th style={{...S.th,textAlign:"right"}}>Amount</th><th style={S.th}>Note</th></tr></thead>
                <tbody>
                  {expenses.map((exp,i)=>(
                    <tr key={i}>
                      <td style={{...S.td,fontSize:11}}>{exp.category}</td>
                      <td style={{...S.td,textAlign:"right"}}><input style={S.inpInline} type="number" value={exp.amount} onChange={e=>setExpenses(prev=>prev.map((x,idx)=>idx===i?{...x,amount:e.target.value}:x))} placeholder="-"/></td>
                      <td style={S.td}><input style={{...S.inpInline,width:80}} value={exp.note} onChange={e=>setExpenses(prev=>prev.map((x,idx)=>idx===i?{...x,note:e.target.value}:x))} placeholder="—"/></td>
                    </tr>
                  ))}
                  {extraExpenses.map((exp,i)=>(
                    <tr key={`x${i}`}>
                      <td style={S.td}><input style={{...S.inpInline,width:100}} value={exp.category} onChange={e=>setExtraExpenses(prev=>prev.map((x,idx)=>idx===i?{...x,category:e.target.value}:x))} placeholder="Category"/></td>
                      <td style={{...S.td,textAlign:"right"}}><input style={S.inpInline} type="number" value={exp.amount} onChange={e=>setExtraExpenses(prev=>prev.map((x,idx)=>idx===i?{...x,amount:e.target.value}:x))} placeholder="-"/></td>
                      <td style={S.td}><div style={{display:"flex",gap:4}}><input style={{...S.inpInline,width:60}} value={exp.note} onChange={e=>setExtraExpenses(prev=>prev.map((x,idx)=>idx===i?{...x,note:e.target.value}:x))} placeholder="—"/><button style={{background:"none",border:"none",color:"#f87171",cursor:"pointer",fontSize:12}} onClick={()=>setExtraExpenses(prev=>prev.filter((_,idx)=>idx!==i))}>✕</button></div></td>
                    </tr>
                  ))}
                  <tr style={{background:"#0f172a"}}><td style={S.td}><strong>PM Fee</strong></td><td style={{...S.td,textAlign:"right"}}><strong>{fmt(pmFee)}</strong></td><td style={S.td}><span style={{background:"#1e3a5f",color:"#60a5fa",fontSize:10,padding:"2px 6px",borderRadius:4}}>Auto</span></td></tr>
                </tbody>
              </table>
              <button style={S.btnG} onClick={()=>setExtraExpenses(prev=>[...prev,{category:"",amount:"",note:""}])}>+ Add expense</button>
              <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",fontSize:13,borderTop:"2px solid #334155",marginTop:8}}><span>Total Expenses</span><span style={{color:"#f87171"}}>-{fmt(totalExpenses)}</span></div>
            </div>
          </div>
        </div>
      ):(
        <div style={{display:"flex",justifyContent:"center",padding:"32px 24px"}}>
          <div id="statement-preview" style={{background:"#fff",color:"#1e293b",borderRadius:8,padding:"40px 48px",width:580,fontFamily:"Georgia,serif",boxShadow:"0 20px 40px rgba(0,0,0,0.3)"}}>
            <div style={{textAlign:"center",marginBottom:24}}>
              <img src={LOGO_URL} alt="Logo" style={{height:80,objectFit:"contain"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:32,borderBottom:"3px solid #1e293b",paddingBottom:16}}>
              <div><div style={{fontSize:22,fontWeight:"bold"}}>Monthly Statement</div><div style={{fontSize:13,color:"#475569",marginTop:4}}>{selectedListing?.name}</div></div>
              <div style={{fontSize:15,color:"#475569",fontStyle:"italic"}}>{MONTHS[selectedMonth]} {selectedYear}</div>
            </div>
            <div style={{marginBottom:20}}>
              <div style={{fontSize:11,textTransform:"uppercase",letterSpacing:"0.1em",color:"#94a3b8",marginBottom:8,borderBottom:"1px solid #e2e8f0",paddingBottom:4}}>Revenue</div>
              {Object.entries(revenueByChannel).map(([ch,{amt}])=>(
                <div key={ch} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}>
                  <span>{ch}</span><span>{fmt(amt)}</span>
                </div>
              ))}
              {midtermAmt > 0 && (
                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}>
                  <span>Other (Direct booking, Furnished Finder){midtermNote ? ` — ${midtermNote}` : ""}</span>
                  <span>{fmt(midtermAmt)}</span>
                </div>
              )}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:"bold",padding:"8px 0",background:"#f8fafc",marginTop:4}}><span>Total Gross Revenue</span><span>{fmt(grossRevenue)}</span></div>
            </div>
            <div style={{marginBottom:20}}>
              <div style={{fontSize:11,textTransform:"uppercase",letterSpacing:"0.1em",color:"#94a3b8",marginBottom:8,borderBottom:"1px solid #e2e8f0",paddingBottom:4}}>Fees</div>
              {af>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}><span>Airbnb Host Fee</span><span>{fmt(af)}</span></div>}
              {at>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}><span>Airbnb Occupancy Tax</span><span>{fmt(at)}</span></div>}
              {vf>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}><span>VRBO Booking Fee</span><span>{fmt(vf)}</span></div>}
              {sf>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}><span>Stripe Booking Fee</span><span>{fmt(sf)}</span></div>}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:"bold",padding:"8px 0",background:"#f8fafc",marginTop:4}}><span>Total Platform Fees</span><span>{fmt(totalPlatformFees)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:"bold",padding:"8px",background:"#1e293b",color:"#f1f5f9",marginTop:4}}><span>Total Revenue Received</span><span>{fmt(totalRevenueReceived)}</span></div>
            </div>
            <div style={{marginBottom:20}}>
              <div style={{fontSize:11,textTransform:"uppercase",letterSpacing:"0.1em",color:"#94a3b8",marginBottom:8,borderBottom:"1px solid #e2e8f0",paddingBottom:4}}>Expenses</div>
              {expenses.filter(e=>parseFloat(e.amount)>0).map((e,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}><span>{e.category}{e.note?<span style={{color:"#94a3b8",marginLeft:6,fontSize:12}}>{e.note}</span>:null}</span><span>{fmt(parseFloat(e.amount))}</span></div>)}
              {extraExpenses.filter(e=>parseFloat(e.amount)>0).map((e,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}><span>{e.category}</span><span>{fmt(parseFloat(e.amount))}</span></div>)}
              {pmRows.map(({label,pmTotal,rate},i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"5px 0",borderBottom:"1px dotted #f1f5f9"}}>
                  <span>PM Fee ({rate}%) {rate===15?"Midterm":"Short-term"} — {label}</span>
                  <span>{fmt(pmTotal)}</span>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:"bold",padding:"8px 0",background:"#f8fafc",marginTop:4}}><span>Total Expenses</span><span>{fmt(totalExpenses)}</span></div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:18,fontWeight:"bold",padding:"16px 0",borderTop:"3px double #475569",color:netRevenue<0?"#dc2626":"#16a34a"}}><span>Net Revenue</span><span>{fmtS(netRevenue)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(null);
  return token ? <StatementBuilder token={token} /> : <AuthScreen onAuth={setToken} />;
}
