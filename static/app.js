'use strict';
const $ = (selector) => document.querySelector(selector);
let stations = [], selected = null, requestId = 0, controller;
let map, markers = [];
const initial = JSON.parse($('#initial-data').textContent);
const storedTheme = localStorage.getItem('charge-theme');
document.documentElement.dataset.theme = storedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('charge-theme', theme); };
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function status(station) { const node = el('span', `${station.operational === true ? '✓' : station.operational === false ? '!' : '?'} ${station.status}`, `status ${station.operational === true ? 'good' : station.operational === false ? 'bad' : ''}`); return node; }
function updateMode() { const zipMode = new FormData($('#search')).get('location_mode') === 'zip'; $('#zip-fields').hidden = !zipMode; $('#coordinate-fields').hidden = zipMode; $('#zip').disabled = !zipMode; for (const name of ['latitude', 'longitude']) { const input = $(`[name=${name}]`); input.disabled = zipMode; input.required = !zipMode; } }
document.querySelectorAll('[name=location_mode]').forEach(input => input.onchange = updateMode); updateMode();
if (window.L) { map = L.map('map', {zoomControl: false}).setView([40.758,-73.9855], 13); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom:19}).addTo(map); L.control.zoom({position:'topright'}).addTo(map); }
else { $('.map-fallback').textContent = 'Map unavailable. Station search still works.'; }
function clearDetail() { $('#detail').hidden = true; $('#results').hidden = false; }
function showDetail(station, index) {
 selected = index; render(); const panel = $('#detail'); panel.replaceChildren();
 const back = el('button','← Back to results','back'); back.onclick = () => { clearDetail(); document.querySelector(`[data-station="${index}"] .card-link`)?.focus(); }; panel.append(back, el('h2',station.name),el('p',station.address),status(station));
 const distance = el('p',`${station.distance_miles.toFixed(2)} miles · straight-line distance`,'telemetry'); panel.append(distance,el('h3','Charging'));
 panel.append(el('div',station.max_power_kw ? `Up to ${station.max_power_kw} kW` : 'Power not provided','detail-row telemetry'));
 for (const connector of station.connectors || []) panel.append(el('div',connector,'detail-row'));
 if (!station.connectors?.length) panel.append(el('p','Connector information not provided'));
 panel.append(el('h3','Pricing'),el('p',station.pricing || 'Price not provided'),el('h3','Before you go'),el('p','Live plug availability unavailable. Amenities not listed. Check the source for access restrictions.'),el('p',`Last verified: ${station.verified ? station.verified.slice(0,10) : 'Unknown'}`));
 const directions = el('a','Directions ↗','primary'); directions.href = `https://www.google.com/maps/dir/?api=1&destination=${station.latitude},${station.longitude}`; directions.target='_blank'; directions.rel='noopener noreferrer';
 const source = el('a','View source on Open Charge Map ↗'); source.href=station.source_url; source.target='_blank'; source.rel='noopener noreferrer'; panel.append(directions,el('br'),source,el('p',`Provider: ${station.provider} · ${station.license}`));
 $('#results').hidden=true; panel.hidden=false; panel.scrollTop=0; back.focus();
 if(map) map.panTo([station.latitude,station.longitude],{animate:!matchMedia('(prefers-reduced-motion: reduce)').matches});
}
function render() {
 const power=$('#power').getAttribute('aria-pressed')==='true', operational=$('#operational').getAttribute('aria-pressed')==='true', connector=$('#connector').value;
 const filtered=stations.map((s,i)=>({s,i})).filter(({s})=>(!power || s.max_power_kw>150)&&(!operational || s.operational===true)&&(!connector || (s.connectors||[]).includes(connector)));
 $('#result-title').textContent=`${filtered.length} station${filtered.length===1?'':'s'} nearby`;
 const list=$('#results');list.replaceChildren();
 if(map) {markers.forEach(marker=>marker.remove());markers=[];}
 for(const {s,i} of filtered) {
  const card=el('article',undefined,`station-card ${selected===i?'selected':''}`);card.dataset.station=i;
  const top=el('div',undefined,'card-top');top.append(el('h2',s.name),el('span',`${s.distance_miles.toFixed(2)} mi`,'distance telemetry'));
  const specs=el('div',undefined,'specs telemetry');specs.append(el('span',s.max_power_kw ? `ϟ Up to ${s.max_power_kw} kW` : 'Power not listed'),el('span',`${s.points ?? 'Unknown'} points`));
  const button=el('button','View details →','card-link');button.setAttribute('aria-label',`View details for ${s.name}`);button.onclick=()=>showDetail(s,i);
  card.append(top,el('p',s.address,'address'),status(s),specs,button);list.append(card);
  if(map){ const marker=L.marker([s.latitude,s.longitude],{icon:L.divIcon({className:`pin ${selected===i?'active':''}`,html:'ϟ',iconSize:[32,36],iconAnchor:[16,36]}),title:s.name,alt:s.name}).addTo(map);marker.on('click',()=>showDetail(s,i));markers.push(marker); }
 }
 if(!filtered.length) list.append(el('p','No matching stations. Increase the radius or clear filters.','address'));
}
for(const id of ['power','operational']) $('#'+id).onclick=()=>{ const button=$('#'+id);button.setAttribute('aria-pressed',button.getAttribute('aria-pressed')!=='true');clearDetail();render();$('#message').textContent='Filters applied to retrieved results.';};
$('#connector').onchange=()=>{clearDetail();render();};
async function search(override={}) {
 const id=++requestId;controller?.abort();controller=new AbortController();
 const data=Object.fromEntries(new FormData($('#search')));data.demo=$('[name=demo]').checked;Object.assign(data,override);
 $('#submit').disabled=true;$('#message').classList.remove('error');$('#message').textContent='Finding your next charge…';$('#results').setAttribute('aria-busy','true');
 try {
  const response=await fetch('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal}); const result=await response.json();if(id!==requestId)return;if(!response.ok)throw Error(result.error || 'Search failed. Please try again.');
  stations=result.stations;selected=null;clearDetail();
  const options=$('#connector');const current=options.value;options.replaceChildren(new Option('All connectors',''));[...new Set(stations.flatMap(s=>s.connectors||[]))].sort().forEach(c=>options.add(new Option(c,c)));options.value=current;if(options.selectedIndex<0)options.value='';
  render();$('#message').textContent=`${result.demo?'DEMO · Fictional stations. ':''}${result.location} · Distances from approximate search center. Showing up to 100 retrieved stations.`;
  if(map){const bounds=L.latLngBounds([result.center,...stations.map(s=>[s.latitude,s.longitude])]);map.fitBounds(bounds,{padding:[40,40],maxZoom:14,paddingBottomRight:innerWidth<768?[30,innerHeight*.58]:[40,40]});}
 }catch(error){if(error.name!=='AbortError'&&id===requestId){$('#message').textContent=error.message;$('#message').classList.add('error');}}
 finally{if(id===requestId){$('#submit').disabled=false;$('#results').removeAttribute('aria-busy');}}
}
$('#search').onsubmit=event=>{event.preventDefault();search();};
$('#sheet-toggle').onclick=()=>{const expanded=$('.browser').classList.toggle('expanded');$('#sheet-toggle').setAttribute('aria-expanded',expanded);$('#sheet-toggle').textContent=expanded?'Collapse results ↓':'Expand results ↑';};
$('#locate').onclick=()=>{if(!navigator.geolocation){$('#message').textContent='Location is unavailable. Enter a ZIP code instead.';return;}navigator.geolocation.getCurrentPosition(position=>{ $('[name=location_mode][value=coordinates]').checked=true;updateMode();$('[name=latitude]').value=position.coords.latitude;$('[name=longitude]').value=position.coords.longitude;search();},()=>{$('#message').textContent='Location access unavailable. Enter a ZIP code instead.';},{timeout:10000});};
if(initial.stations.length){stations=initial.stations;render();}
