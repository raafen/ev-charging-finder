// Local-first calculations. Keep rules aligned with domain.py; no vehicle specifications are inferred.
export const CONNECTORS = ['NACS', 'J1772', 'CCS1', 'CHAdeMO', 'Type 2', 'CCS2'];
export const CONNECTOR_LABELS = {NACS:'NACS / SAE J3400', J1772:'SAE J1772 / Type 1', CCS1:'CCS1', CHAdeMO:'CHAdeMO', 'Type 2':'Type 2', CCS2:'CCS2'};
export function compatibility(vehicle, station) {
  const rows = (station.connections?.length ? station.connections : (station.connectors || []).map(connector=>({connector,current_type:'Unknown'}))).map(connection=>{
    const connector=connection.connector || connection.type || 'Unknown', current=connection.current_type || 'Unknown';
    let physical='unknown', reason='Select a vehicle and confirm its inlet and charging capability.';
    if(vehicle?.connectors?.length && connector!=='Unknown') {
      const native=vehicle.connectors.includes(connector) || (connector==='J1772' && vehicle.connectors.includes('CCS1')) || (connector==='Type 2' && vehicle.connectors.includes('CCS2'));
      const adapter=(vehicle.adapters || []).some(a=>a.from===connector && vehicle.connectors.includes(a.to) && a.current_type===current && ['AC','DC'].includes(current));
      const uncertainAdapter=(vehicle.adapters||[]).some(a=>a.from===connector&&vehicle.connectors.includes(a.to)&&(!['AC','DC'].includes(current)||!['AC','DC'].includes(a.current_type)));
      if(native) {physical='compatible';reason=`${CONNECTOR_LABELS[connector] || connector} fits the recorded inlet. Physical fit alone does not establish charging capability or network authorization.`;}
      else if(adapter) {physical='adapter_required';reason='Matches an adapter you recorded for this connector and current type. Verify manufacturer approval and voltage limits.';}
      else if(uncertainAdapter) {physical='unknown';reason='Adapter current-type approval is not specified.';}
      else {physical='incompatible';reason='No matching native inlet or explicitly recorded, current-type-compatible adapter.';}
    }
    return {connector,current_type:current,physical,reason,network:station.network_access==='open'||(station.network_access==='restricted'&&vehicle?.networks?.includes(station.network))?'allowed':'unknown'};
  });
  const rank=['compatible','adapter_required','unknown','incompatible'];
  const physical=rows.length?rank.find(value=>rows.some(row=>row.physical===value)):'unknown';
  return {physical,connections:rows,network:rows.length&&rows.every(row=>row.network==='allowed')?'allowed':'unknown'};
}
export const compatibilityLabel = value=>({compatible:'Native connector',adapter_required:'Adapter required',incompatible:'Incompatible',unknown:'Compatibility unknown'}[value] || 'Compatibility unknown');
export function estimate(input) {
  const n=(key,min,max,optional=false)=>{const raw=input[key];if(optional&&(raw===''||raw==null))return null;const value=Number(raw);if(raw===''||raw==null||!Number.isFinite(value)||value<min||value>max)throw Error(`Check ${key.replaceAll('_',' ')} (${min}–${max}).`);return value;};
  const start=n('start',0,100),target=n('target',0,100);if(target<=start)throw Error('Target battery percentage must exceed starting percentage.');
  const battery=n('battery',1,500),charger=n('charger',.1,2000),vehicle=n('vehicle',.1,2000),efficiency=n('efficiency',1,100)/100,consumption=n('consumption',1,200);
  const batteryEnergy=battery*(target-start)/100,gridEnergy=batteryEnergy/efficiency,power=Math.min(charger,vehicle),minutes=gridEnergy/power*60;
  const kwh=n('kwh_rate',0,100,true),minute=n('minute_rate',0,100,true),session=n('session_fee',0,10000,true),parking=n('parking_fee',0,10000,true);
  const fees={energy:kwh===null?null:gridEnergy*kwh,time:minute===null?null:minutes*minute,session,parking};
  const known=Object.values(fees).filter(x=>x!==null).reduce((a,b)=>a+b,0),complete=Object.values(fees).every(x=>x!==null);
  return {batteryEnergy,gridEnergy,power,minutes,miles:batteryEnergy/consumption*100,fees,known,total:complete?known:null,complete};
}
export function milesBetween(a,b) {
 const rad=Math.PI/180,lat=(b[0]-a[0])*rad,lon=(b[1]-a[1])*rad;
 const h=Math.sin(lat/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(lon/2)**2;
 return 3958.7613*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
