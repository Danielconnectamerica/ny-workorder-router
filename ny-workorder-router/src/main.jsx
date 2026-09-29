import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { readPdf, packet, safeStreet } from './pdf.js';
import { approximateMatrix, optimize, feasibleCounts, zipEstimate } from './routing.js';
import './style.css';

function App() {
  const [password, setPassword] = useState('');
  const [file, setFile] = useState(null);
  const [bytes, setBytes] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [installers, setInstallers] = useState([{ name: '', email: '' }]);
  const [routes, setRoutes] = useState([]);
  const [mode, setMode] = useState('approximate');
  const [pilot, setPilot] = useState(false);
  const [status, setStatus] = useState('Choose a PDF to start.');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState({});
  const [dispatchId, setDispatchId] = useState('');

  const hasErrors = jobs.some(j => j.errors.length);
  const geoReady = jobs.length && jobs.every(j => j.geo && Number.isFinite(j.geo.lat) && Number.isFinite(j.geo.lon) && (j.geo.match === 'Match' || (pilot && j.geo.match === 'Zip_Estimate')));
  const counts = feasibleCounts(jobs.length, installers.length);
  const capacityReady = !!counts || (pilot && jobs.length >= installers.length && jobs.length <= 16 * installers.length);
  const installerReady = installers.every(x => x.name.trim());
  const invalidate = () => { setRoutes([]); setSent({}); };
  async function call(path, body) {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dispatch-password': password }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${path} failed`);
    return data;
  }
  async function upload(input) {
    if (!input) return;
    setBusy(true); setJobs([]); setBytes(null); setFile(input); invalidate();
    try {
      setStatus('Reading PDF in this browser…');
      const result = await readPdf(input, (page, total) => setStatus(`Reading page ${page} of ${total}…`));
      setBytes(result.bytes); setJobs(result.jobs);
      setStatus(`${result.jobs.length} work orders found${result.skippedPages.length ? `; skipped blank PDF page(s) ${result.skippedPages.join(', ')}` : ''}. Review extracted fields, then match addresses.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function editJob(page, key, value) {
    setJobs(old => {
      const edited = old.map(j => j.page === page ? { ...j, [key]: value, geo: null } : j);
      const ids = edited.map(j => j.id).filter(Boolean);
      return edited.map(j => {
        const errors = [];
        if (!j.id) errors.push('Missing work order number');
        if (!j.street || !j.city || !j.zip || !j.state) errors.push('Incomplete service address');
        if (j.state && j.state !== 'NY') errors.push('Outside NY');
        if (j.id && ids.filter(id => id === j.id).length > 1) errors.push('Duplicate work order number');
        if (new Set(edited.map(x => x.appointment.split(' ')[0]).filter(Boolean)).size > 1) errors.push('Mixed appointment dates in upload');
        return { ...j, errors };
      });
    });
    invalidate();
  }
  async function geocode(pages = null) {
    setBusy(true); invalidate();
    try {
      const selected = pages ? jobs.filter(j => pages.includes(j.page)) : jobs;
      setStatus(`Matching ${selected.length === 1 ? 'address' : `${selected.length} addresses`} with the U.S. Census geocoder…`);
      const { results } = await call('geocode', { jobs: selected.map(j => ({ page: j.page, street: safeStreet(j.street), city: j.city, state: j.state, zip: j.zip })) });
      const byPage = new Map(results.map(x => [x.page, x]));
      setJobs(old => old.map(j => byPage.has(j.page) ? { ...j, geo: byPage.get(j.page) } : j));
      const matched = results.filter(x => x.match === 'Match' && Number.isFinite(x.lat) && Number.isFinite(x.lon)).length;
      setStatus(`${matched} of ${selected.length} checked address${selected.length === 1 ? '' : 'es'} matched. Edit an unmatched row and use Check this address.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function useZipArea(page) {
    const target = jobs.find(j => j.page === page);
    const estimate = zipEstimate(jobs, target.zip);
    if (!estimate) return;
    setJobs(old => old.map(j => j.page === page ? { ...j, geo: estimate } : j));
    invalidate();
    setStatus(`Page ${page} uses an approximate ZIP-area location for pilot routing. Confirm its placement manually on the route review.`);
  }
  async function buildRoutes() {
    setBusy(true);
    try {
      setStatus('Building routes…');
      let matrix = approximateMatrix(jobs);
      if (mode === 'roads') matrix = (await call('matrix', { points: jobs.map(j => ({ lon: j.geo.lon, lat: j.geo.lat })) })).matrix;
      const next = optimize(jobs, installers.length, matrix, { allowShort: pilot });
      setRoutes(next); setSent({}); setDispatchId(globalThis.crypto.randomUUID());
      setStatus(`${next.length} routes ready. Review every assignment before sending.`);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); }
  }
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const filename = (route, installer) => {
    const date = route.jobs[0]?.appointment.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const day = date ? `${date[3]}-${date[1].padStart(2, '0')}-${date[2].padStart(2, '0')}` : new Date().toISOString().slice(0, 10);
    return `${installer.name.trim().replace(/[^\w-]+/g, '_')}_${day}_${route.jobs.length}_WorkOrders.pdf`;
  };
  function mapLinks(route) {
    const places = route.jobs.map(j => `${safeStreet(j.street)}, ${j.city}, ${j.state} ${j.zip}`);
    const links = [];
    for (let i = 0; i < places.length - 1; i += 7) {
      const chunk = places.slice(i, Math.min(i + 8, places.length));
      const params = new URLSearchParams({ api: '1', origin: chunk[0], destination: chunk.at(-1) });
      if (chunk.length > 2) params.set('waypoints', chunk.slice(1, -1).join('|'));
      links.push(`https://www.google.com/maps/dir/?${params}`);
    }
    return links;
  }
  async function sendRoute(route, installer, i) {
    setBusy(true);
    try {
      const pdf = await packet(bytes, route);
      const base64 = btoa(Array.from({ length: Math.ceil(pdf.length / 8192) }, (_, k) => String.fromCharCode(...pdf.slice(k * 8192, (k + 1) * 8192))).join(''));
      const date = route.jobs[0]?.appointment.split(' ')[0] || new Date().toLocaleDateString();
      const name = filename(route, installer);
      await call('send', { email: installer.email.trim(), filename: name, contentBase64: base64, dispatchId: `${dispatchId}-${i + 1}`, orderIds: route.jobs.map(j => j.id), subject: `Installation work orders – ${date} – ${route.jobs.length} stops`, body: `Hello ${installer.name.trim()},\n\nAttached are your ${route.jobs.length} assigned work orders in recommended stop order.\n\nWork orders: ${route.jobs.map(j => j.id).join(', ')}\n\nPlease contact dispatch if an assignment needs to change.` });
      setSent(old => ({ ...old, [i]: true })); setStatus(`Email flow accepted route ${i + 1} for ${installer.email}.`);
    } catch (error) { setStatus(`Route ${i + 1}: ${error.message}`); }
    finally { setBusy(false); }
  }

  return <main>
    <header><div><span className="eyebrow">DISPATCH WORKSPACE</span><h1>New York work order router</h1><p>Upload one PDF. Check each address. Build installer packets in stop order.</p></div><span className="pill">Local PDF processing</span></header>
    <section className="panel"><h2>1. Upload work orders</h2><p>One work order per page, using the same form as the sample. The PDF stays in this browser until you close the tab.</p><input aria-label="Bulk work order PDF" type="file" accept="application/pdf" disabled={busy} onChange={e => upload(e.target.files[0])}/>{file && <small>{file.name} · {jobs.length} pages</small>}</section>
    <section className="panel"><h2>2. Review addresses</h2><p>Address matching sends street addresses to the U.S. Census service; original PDF pages are not sent.</p>
      {jobs.length > 0 && <><div className="scroll"><table><thead><tr><th>Page / WO</th><th>Street</th><th>City</th><th>State</th><th>ZIP</th><th>Address check</th></tr></thead><tbody>{jobs.map(j => <tr key={j.page}><td>{j.page}<br/><input className="short" aria-label={`Work order page ${j.page}`} value={j.id} onChange={e => editJob(j.page, 'id', e.target.value)}/></td><td><input aria-label={`Street page ${j.page}`} value={j.street} onChange={e => editJob(j.page, 'street', e.target.value)}/></td><td><input aria-label={`City page ${j.page}`} value={j.city} onChange={e => editJob(j.page, 'city', e.target.value)}/></td><td><input className="state" aria-label={`State page ${j.page}`} value={j.state} onChange={e => editJob(j.page, 'state', e.target.value.toUpperCase())}/></td><td><input className="zip" aria-label={`ZIP page ${j.page}`} value={j.zip} onChange={e => editJob(j.page, 'zip', e.target.value)}/></td><td className={j.errors.length || (j.geo && j.geo.match !== 'Match') ? 'warn' : 'good'}>{j.errors.join('; ') || (j.geo ? j.geo.match === 'Match' ? `Matched: ${j.geo.matchedAddress}` : j.geo.match === 'Zip_Estimate' ? j.geo.matchedAddress : 'No exact match — edit and retry' : 'Not checked')}{j.geo?.match !== 'Match' && j.geo?.match !== 'Zip_Estimate' && <div><button className="quiet" disabled={busy || !j.street || !j.city || j.state !== 'NY' || !/^\d{5}$/.test(j.zip)} onClick={() => geocode([j.page])}>Check this address</button>{j.geo && zipEstimate(jobs, j.zip) && <button className="quiet" disabled={busy} onClick={() => useZipArea(j.page)}>Use ZIP area for pilot</button>}</div>}</td></tr>)}</tbody></table></div><button disabled={busy || hasErrors || jobs.some(j => !j.id || !j.street || !j.city || j.state !== 'NY' || !/^\d{5}$/.test(j.zip))} onClick={() => geocode()}>Match all addresses</button></>}
    </section>
    <section className="panel"><h2>3. Assign installers</h2><p>Enter installer names to test routes. Company email is needed only when sending packets. Strict dispatch requires 14–16 stops per route.</p>{installers.map((x, i) => <div className="installer" key={i}><input aria-label={`Installer ${i + 1} name`} placeholder="Installer name" value={x.name} onChange={e => { setInstallers(old => old.map((y, k) => k === i ? { ...y, name: e.target.value } : y)); invalidate(); }}/><input aria-label={`Installer ${i + 1} email`} type="email" placeholder="installer@company.com (optional for testing)" value={x.email} onChange={e => { setInstallers(old => old.map((y, k) => k === i ? { ...y, email: e.target.value } : y)); invalidate(); }}/><button className="quiet" disabled={installers.length === 1} onClick={() => { setInstallers(old => old.filter((_, k) => k !== i)); invalidate(); }}>Remove</button></div>)}<button className="quiet" onClick={() => { setInstallers(old => [...old, { name: '', email: '' }]); invalidate(); }}>+ Add installer</button>
      <label>Dispatcher password (only for configured road routing or email)<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank for approximate route testing"/></label>
      {jobs.length > 0 && <p className={capacityReady ? 'good' : 'warn'}>{counts ? `Feasible: ${counts.join(', ')} jobs per installer.` : `${jobs.length} jobs cannot fill ${installers.length} routes at 14–16 each.`}</p>}
      <label className="check"><input type="checkbox" checked={pilot} onChange={e => { setPilot(e.target.checked); invalidate(); }}/> Pilot override: allow fewer than 14 stops (clearly review the results)</label>
      <div className="choice"><label><input type="radio" name="mode" value="approximate" checked={mode === 'approximate'} onChange={() => { setMode('approximate'); invalidate(); }}/> Free approximate distance (no drive times)</label><label><input type="radio" name="mode" value="roads" checked={mode === 'roads'} onChange={() => { setMode('roads'); invalidate(); }}/> Driving times (requires configured OSRM server)</label></div>
      <button disabled={busy || !geoReady || hasErrors || !installerReady || !capacityReady} onClick={buildRoutes}>Build routes</button>
    </section>
    {routes.length > 0 && <section className="panel"><h2>4. Review and send packets</h2><p>Routes are suggestions. Appointment timestamps are shown for review; they are not enforced as time windows. The estimate excludes installation time and travel to the first stop. Email requires a configured Power Automate flow, installer email, and dispatcher password; downloads work without them.</p>{routes.map((r, i) => <article className="route" key={i}><div className="routehead"><div><h3>Route {i + 1} · {installers[i].name} · {r.jobs.length} stops</h3><small>{mode === 'roads' ? 'Road' : 'Approximate'} travel between stops: {r.travelMinutes} min</small></div><div className="actions"><button className="quiet" onClick={async () => { const pdf = await packet(bytes, r); download(pdf, filename(r, installers[i])); }}>Download PDF</button><button disabled={busy || sent[i] || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(installers[i].email) || r.jobs.some(j => j.geo?.match !== 'Match')} onClick={() => sendRoute(r, installers[i], i)}>{sent[i] ? 'Accepted by email flow' : 'Email this installer'}</button></div></div><div className="links">{mapLinks(r).map((url, k) => <a key={k} href={url} target="_blank" rel="noreferrer">Directions segment {k + 1} ↗</a>)}</div><ol>{r.jobs.map(j => <li key={j.page}><strong>WO {j.id}</strong> · {j.street}, {j.city} {j.zip} <small>· PDF page {j.page} · appointment {j.appointment || 'unknown'}{j.geo?.match === 'Zip_Estimate' ? ' · ZIP-AREA ESTIMATE: verify location' : ''}</small></li>)}</ol></article>)}</section>}
    <div role="status" className="status">{busy ? 'Working… ' : ''}{status}</div>
    <footer>Private dispatcher tool · No PDF storage or route history · Verify times, traffic, and appointments before sending.</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
