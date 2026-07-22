/* ═══════════════════════════════════════════════════════════
   SHARED CONFIG + DATA LAYER
   ═══════════════════════════════════════════════════════════ */
const DEFAULT_ADMIN_EMAIL = 'admin@yourdomain.com';
const ADMIN_PASSWORD = '123admin'; // ← change this!

/* ── Supabase client ── */
const SUPABASE_URL = 'https://vycynubbqliimfssukgt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5Y3ludWJicWxpaW1mc3N1a2d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0ODUyNTEsImV4cCI6MjA5OTA2MTI1MX0.DoUseuyz3KXcK79eo6rZLGrQPEOPdDdFsPfLA6osRfg';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function getAdminEmail(){ return localStorage.getItem('zms_admin_email') || DEFAULT_ADMIN_EMAIL; }
function setAdminEmail(v){
  localStorage.setItem('zms_admin_email', v);
  sb.from('settings').upsert({ id:'admin_email', value:v }).then(({error})=>{
    if(error){ console.error('Could not sync admin email:', error); showToast('Could not save admin email to the database.','error'); }
  });
}
async function pullAdminEmailFromCloud(){
  const { data, error } = await sb.from('settings').select('value').eq('id','admin_email').single();
  if(error){ console.error('Could not load admin email:', error); return; }
  if(data && data.value){ localStorage.setItem('zms_admin_email', data.value); }
}

/* ── Bookings: local cache (instant, synchronous) ──
   `bookings` stays a normal in-memory array everywhere in this file,
   so the rest of the app (100+ references) doesn't need to change.
   localStorage is just the instant local cache; Supabase is the
   real source of truth, synced in the background. */
function loadBookings(){
  try{ return JSON.parse(localStorage.getItem('zms_bookings')||'null') || []; }
  catch(e){ return []; }
}
function saveBookings(arr){
  localStorage.setItem('zms_bookings', JSON.stringify(arr));
  return pushBookingsToCloud(arr);
}
let bookings = loadBookings();

/* Convert between the app's JS shape and the DB row shape
   ('end' is a reserved word in SQL, so the DB column is end_time). */
function bookingToRow(b){
  return {
    id: b.id, title: b.title, name: b.name, agency: b.agency,
    date: b.date, shift: b.shift, start_time: b.start, end_time: b.end,
    pax: b.pax, account_id: b.accountId, recurring: !!b.recurring,
    freq: b.freq, count: b.count, days: (b.days||[]).join(','), notes: b.notes,
    registration: !!b.registration, security: b.security || 'waiting_room_passcode',
    status: b.status, submitted: b.submitted
  };
}
function rowToBooking(r){
  return {
    id: r.id, title: r.title, name: r.name, agency: r.agency,
    date: r.date, shift: r.shift, start: r.start_time, end: r.end_time,
    pax: r.pax, accountId: r.account_id, recurring: r.recurring,
    freq: r.freq, count: r.count, days: r.days ? r.days.split(',').filter(Boolean) : [], notes: r.notes,
    registration: !!r.registration, security: r.security || 'waiting_room_passcode',
    status: r.status, submitted: r.submitted
  };
}

/* Push the whole in-memory array to Supabase as an upsert.
   Bookings are never hard-deleted in this app (only their status
   changes), so upsert alone keeps the table in sync. Fire-and-forget
   from the caller's point of view, but logs + toasts on failure. */
async function pushBookingsToCloud(arr){
  if(!arr.length) return true;
  // Guard against corrupted/legacy localStorage entries (e.g. missing id,
  // which is the primary key). Postgres rejects an *entire* upsert batch
  // if any single row violates a constraint, so one bad old row would
  // otherwise silently block every new booking from ever saving.
  const rows = arr.map(bookingToRow).filter(r=>{
    const ok = !!r.id;
    if(!ok) console.warn('Skipping malformed booking row (no id), not sent to Supabase:', r);
    return ok;
  });
  if(!rows.length) return true;
  const { error } = await sb.from('bookings').upsert(rows);
  if(error){
    console.error('Supabase bookings upsert failed:', error);
    showToast('Could not save booking to the database — check your connection.','error');
    return false;
  }
  return true;
}

/* Pull the latest bookings from Supabase, refresh the local cache,
   and re-render whatever's currently on screen. Called on page load
   and whenever a realtime change comes in from another tab/device. */
async function pullBookingsFromCloud(){
  const { data, error } = await sb.from('bookings').select('*').order('submitted', { ascending: false }).order('id', { ascending: false });
  if(error){ console.error('Supabase bookings fetch failed:', error); return; }
  bookings = data.map(rowToBooking);
  localStorage.setItem('zms_bookings', JSON.stringify(bookings));
  refreshVisibleViews();
}

/* Sort key for "most recently submitted first". Uses the numeric part of
   the booking ID (BK-001, BK-002, ...) as the primary key — IDs are a
   strictly increasing creation-order counter, so unlike the `submitted`
   column (date-only, ties on same-day submissions) this always breaks
   ties correctly. Applied client-side everywhere bookings are listed, on
   top of the DB-level order above, as a defensive backstop. */
function idNum(b){ const m = /(\d+)\s*$/.exec(b.id||''); return m ? parseInt(m[1],10) : -1; }
function sortByNewest(arr){
  return arr.slice().sort((a,b)=>{
    const diff = idNum(b) - idNum(a);
    if(diff !== 0) return diff;
    return (b.submitted||'').localeCompare(a.submitted||'');
  });
}

/* Meeting security label lookup (mirrors Zoom's own security options) */
const SECURITY_LABELS = {
  waiting_room_passcode:'Waiting Room + Passcode',
  waiting_room:'Waiting Room Only',
  passcode:'Passcode Only',
  authenticated_users:'Only Authenticated Users Can Join',
  none:'None (Open Join)'
};
function securityLabel(val){ return SECURITY_LABELS[val] || SECURITY_LABELS.waiting_room_passcode; }

/* Human-readable recurrence summary, e.g. "weekly × 4 (Mon, Tue, Wed)" */
function recurLabel(b){
  if(!b.recurring) return '';
  const daysPart = ((b.freq==='weekly'||b.freq==='monthly') && b.days && b.days.length) ? ` (${b.days.join(', ')})` : '';
  return `${b.freq} × ${b.count}${daysPart}`;
}

/* ═══════════════════════════════════════════════════════════
   ZOOM ACCOUNTS DATA LAYER
   ═══════════════════════════════════════════════════════════ */
function loadAccounts(){
  let arr;
  try{ arr = JSON.parse(localStorage.getItem('zms_accounts')||'null') || []; }
  catch(e){ arr = []; }
  if(autoExpireAccounts(arr)) saveAccounts(arr);
  return arr;
}
function saveAccounts(arr){
  localStorage.setItem('zms_accounts', JSON.stringify(arr));
  pushAccountsToCloud(arr);
}
/* Flip any 'active' account whose expiry date has passed to 'expired'.
   Runs every time accounts are loaded, so expiry is enforced automatically
   (no need for anyone to click "Expire" manually). Returns true if anything changed. */
function autoExpireAccounts(arr){
  const now = new Date();
  let changed = false;
  arr.forEach(a=>{
    if(a.status==='active' && a.expiry){
      const expiryEnd = new Date(a.expiry+'T23:59:59'); // active through the entire expiry day
      if(expiryEnd < now){ a.status = 'expired'; changed = true; }
    }
  });
  return changed;
}
let zoomAccounts = loadAccounts();

/* Account fields match the DB columns 1:1, so no row-mapping needed. */
async function pushAccountsToCloud(arr){
  if(!arr.length) return;
  const rows = arr.map(a => ({ ...a, expiry: a.expiry || null }));
  const { error } = await sb.from('accounts').upsert(rows);
  if(error){ console.error('Supabase accounts upsert failed:', error); showToast('Could not save account to the database — check your connection.','error'); }
}
async function deleteAccountFromCloud(id){
  const { error } = await sb.from('accounts').delete().eq('id', id);
  if(error){ console.error('Supabase account delete failed:', error); showToast('Could not delete account from the database.','error'); }
}
async function pullAccountsFromCloud(){
  const { data, error } = await sb.from('accounts').select('*');
  if(error){ console.error('Supabase accounts fetch failed:', error); return; }
  zoomAccounts = data;
  autoExpireAccounts(zoomAccounts);
  localStorage.setItem('zms_accounts', JSON.stringify(zoomAccounts));
  refreshVisibleViews();
}

/* ── Realtime: pick up changes from other tabs/devices automatically ── */
sb.channel('bookings-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => pullBookingsFromCloud())
  .subscribe();
sb.channel('accounts-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, () => pullAccountsFromCloud())
  .subscribe();

/* Re-render whichever views are currently visible, after a cloud sync.
   Wrapped in try/catch per-call so a missing element/undefined state on
   one view never blocks refreshing the others. */
function refreshVisibleViews(){
  try{ if(typeof activePax !== 'undefined' && activePax) renderCal(); }catch(e){}
  try{ if(document.getElementById('tab-existing') && document.getElementById('tab-existing').style.display !== 'none') renderExisting(); }catch(e){}
  try{ if(document.getElementById('admin-wrap') && document.getElementById('admin-wrap').classList.contains('visible')){ loadAdminBookings(); renderAccountsGrid(); } }catch(e){}
}

/* Initial cloud sync on page load */
pullBookingsFromCloud();
pullAccountsFromCloud();
pullAdminEmailFromCloud();

function genAccountId(){
  const nums = zoomAccounts.map(a=>parseInt(a.id.split('-')[1]||0));
  const next  = nums.length ? Math.max(...nums)+1 : 1;
  return 'ACC-'+String(next).padStart(3,'0');
}

/* ═══════════════════════════════════════════════════════════
   UTILITY
   ═══════════════════════════════════════════════════════════ */

function getEffDates(b){
  const dates = [b.date]; // the requested date is always included, weekday or weekend
  const base  = new Date(b.date + 'T00:00:00');
  if(b.recurring && b.count > 1){
    if(b.freq==='daily'){
      let collected = 0;
      const needed  = b.count - 1;
      const cursor  = new Date(base);
      while(collected < needed){
        cursor.setDate(cursor.getDate() + 1);
        dates.push(toLocalISODate(cursor)); collected++;
      }
    } else if(b.freq==='weekly'){
      const dayAbbrs = (b.days && b.days.length) ? b.days : [DAY_ORDER[(base.getDay()+6)%7]];
      const offsets  = dayAbbrs.map(d=>DAY_ORDER.indexOf(d)).filter(i=>i>=0).sort((a,b2)=>a-b2);
      const anchorOffset = (base.getDay()+6)%7; // Mon=0 ... Sun=6
      const monday = new Date(base);
      monday.setDate(monday.getDate() - anchorOffset);
      for(let w=0; w<b.count; w++){
        for(const off of offsets){
          const d = new Date(monday);
          d.setDate(d.getDate() + w*7 + off);
          if(d < base) continue; // never schedule an occurrence before the requested start date
          const iso = toLocalISODate(d);
          if(!dates.includes(iso)) dates.push(iso);
        }
      }
    } else if(b.freq==='monthly'){
      const dayAbbrs = (b.days && b.days.length) ? b.days : [DAY_ORDER[(base.getDay()+6)%7]];
      const offsets  = dayAbbrs.map(d=>DAY_ORDER.indexOf(d)).filter(i=>i>=0);
      // Which occurrence of its weekday the base date is within its month (1st, 2nd, 3rd...)
      const ordinal  = Math.ceil(base.getDate() / 7);
      for(let m=1; m<b.count; m++){
        const targetMonth = new Date(base.getFullYear(), base.getMonth()+m, 1);
        for(const off of offsets){
          const jsWeekday = (off+1)%7; // convert Mon=0..Sun=6 (DAY_ORDER) to JS Sun=0..Sat=6
          const matches = [];
          const d = new Date(targetMonth);
          while(d.getMonth() === targetMonth.getMonth()){
            if(d.getDay() === jsWeekday) matches.push(new Date(d));
            d.setDate(d.getDate() + 1);
          }
          // Clamp to the last matching weekday if the month doesn't have a 5th occurrence
          const chosen = matches[ordinal-1] || matches[matches.length-1];
          if(chosen){
            const iso = toLocalISODate(chosen);
            if(!dates.includes(iso)) dates.push(iso);
          }
        }
      }
    }
  }
  return dates;
}
function toLocalISODate(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function getBookingWindow(){
  const today = new Date(); today.setHours(0,0,0,0);
  const maxDate = new Date(today.getFullYear(), today.getMonth()+2, 0);
  return { minDate: today, maxDate };
}

// Email notifications are now sent server-side by a Supabase Edge
// Function (send-booking-email), triggered automatically by a Database
// Webhook whenever a new row is inserted into `bookings`. No client-side
// call needed — see supabase/functions/send-booking-email/index.ts.

/* ══ OVERLAYS ══ */
function handleOvClick(e,id){ if(e.target.id===id) closeOverlay(id); }
function closeOverlay(id){ document.getElementById(id).classList.remove('open'); }
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    ['book-overlay','detail-ov','export-ov','account-ov','delete-account-ov'].forEach(id=>closeOverlay(id));
  }
});

/* ══ TOAST ══ */
function showToast(msg,type='info'){
  const icons={success:'ti-circle-check',error:'ti-alert-circle',info:'ti-info-circle'};
  const t=document.createElement('div'); t.className=`toast ${type}`;
  t.innerHTML=`<i class="ti ${icons[type]}"></i><span>${msg}</span>`;
  document.getElementById('toast-wrap').appendChild(t);
  setTimeout(()=>t.remove(),4500);
}

/* ═══════════════════════════════════════════════════════════
   ROUTER
   ═══════════════════════════════════════════════════════════ */
// In-memory only (not sessionStorage) — deliberately does NOT survive
// navigating away from #admin, so back/forward into the admin route
// always re-prompts for the password instead of silently letting you in.
let adminAuthed = false;
function route(){
  const isAdmin = location.hash.replace('#','').startsWith('admin');
  document.getElementById('user-app').style.display  = isAdmin ? 'none' : '';
  document.getElementById('admin-app').style.display = isAdmin ? '' : 'none';
  if(isAdmin){
    if(adminAuthed){
      showAdminPanel();
    } else {
      document.getElementById('login-wrap').style.display='flex';
      document.getElementById('admin-wrap').classList.remove('visible');
    }
  } else {
    // Leaving the admin route (Back to Scheduler, browser back/forward,
    // or any other hash change) always revokes the session.
    adminAuthed = false;
    stopReminderWatcher();
  }
}
function goToScheduler(){ location.hash=''; }
window.addEventListener('hashchange', route);

/* ═══════════════════════════════════════════════════════════
   USER APP
   ═══════════════════════════════════════════════════════════ */
let isDark = document.documentElement.getAttribute('data-theme') !== 'light';
function toggleTheme(){
  isDark = !isDark;
  document.documentElement.setAttribute('data-theme', isDark ? '' : 'light');
  ['theme-icon','admin-theme-icon'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.className = isDark ? 'ti ti-moon' : 'ti ti-sun';
  });
  ['theme-lbl','admin-theme-lbl'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.textContent = isDark ? 'Dark' : 'Light';
  });
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let calMonth  = new Date(2026, 6, 1);
let activePax = null;
let activeAccountId = null;
let selShiftV = 'AM';
let drawerDate = null;

function getAccountById(id){
  return zoomAccounts.find(a => a.id === id) || null;
}

/* Shared helper: true if an active account's license expires within 30 days */
function isExpiringSoon(a){
  if(!a || a.status !== 'active' || !a.expiry) return false;
  const msLeft = new Date(a.expiry+'T23:59:59') - new Date();
  return msLeft > 0 && msLeft < 30*24*60*60*1000;
}

function updateBookingFormAccountSelection(){
  const fAccount = document.getElementById('f-account');
  const fPax = document.getElementById('f-pax');
  if(!fAccount || !fPax) return;

  const activeAccounts = zoomAccounts.filter(a => a.status === 'active');
  fAccount.innerHTML = '';
  activeAccounts.forEach(acc => {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = `${acc.name} — ${acc.capacity} pax`;
    fAccount.appendChild(opt);
  });

  const selectedAccount = activeAccounts.find(a => a.id === activeAccountId) || activeAccounts[0];
  if(selectedAccount){
    fAccount.value = selectedAccount.id;
    fPax.value = selectedAccount.capacity;
    activeAccountId = selectedAccount.id;
    activePax = selectedAccount.capacity;
  }
}

function onBookingAccountChange(){
  const fAccount = document.getElementById('f-account');
  const fPax = document.getElementById('f-pax');
  if(!fAccount || !fPax) return;
  const selectedId = fAccount.value;
  const selectedAcc = getAccountById(selectedId);
  if(selectedAcc){
    fPax.value = selectedAcc.capacity;
    activeAccountId = selectedAcc.id;
    activePax = selectedAcc.capacity;
  }
}

function onPaxRoomChange(){
  const fAccount = document.getElementById('f-account');
  const fPax = document.getElementById('f-pax');
  if(!fAccount || !fPax) return;
  const selectedPax = fPax.value;
  const matching = zoomAccounts.filter(a => a.status==='active' && a.capacity === selectedPax);
  if(matching.length){
    fAccount.value = matching[0].id;
    activeAccountId = matching[0].id;
    activePax = selectedPax;
  }
}

const AM_WIN = [7*60, 12*60];
const PM_WIN = [13*60, 18*60];
function timeToMin(t){ const [h,m]=t.split(':').map(Number); return h*60+m; }
function overlapsWindow(b, winStart, winEnd){
  const s = timeToMin(b.start), e = timeToMin(b.end);
  return s < winEnd && winStart < e;
}
function coveredMinutes(bks, winStart, winEnd){
  const ivs = bks
    .map(b=>[Math.max(timeToMin(b.start),winStart), Math.min(timeToMin(b.end),winEnd)])
    .filter(([s,e])=>e>s)
    .sort((a,b)=>a[0]-b[0]);
  const merged=[];
  for(const iv of ivs){
    if(merged.length && iv[0]<=merged[merged.length-1][1]) merged[merged.length-1][1]=Math.max(merged[merged.length-1][1],iv[1]);
    else merged.push(iv);
  }
  return merged.reduce((sum,[s,e])=>sum+(e-s),0);
}
function getSlot(dateStr, pax, accountId){
  const relevant = bookings.filter(b => b.status!=='DENIED' && b.pax==pax && getEffDates(b).includes(dateStr) && (accountId ? b.accountId===accountId : true));
  const approved = relevant.filter(b => b.status==='APPROVED');
  const pending  = relevant.filter(b => b.status==='PENDING');
  const amCovered = coveredMinutes(approved, AM_WIN[0], AM_WIN[1]);
  const pmCovered = coveredMinutes(approved, PM_WIN[0], PM_WIN[1]);
  const amApproved = amCovered >= (AM_WIN[1]-AM_WIN[0]);
  const pmApproved = pmCovered >= (PM_WIN[1]-PM_WIN[0]);
  const amPartial  = amCovered > 0 && !amApproved;
  const pmPartial  = pmCovered > 0 && !pmApproved;
  const amPending  = pending.some(b => overlapsWindow(b, AM_WIN[0], AM_WIN[1]));
  const pmPending  = pending.some(b => overlapsWindow(b, PM_WIN[0], PM_WIN[1]));
  const amRecurring = approved.some(b => overlapsWindow(b, AM_WIN[0], AM_WIN[1]) && b.recurring);
  const pmRecurring = approved.some(b => overlapsWindow(b, PM_WIN[0], PM_WIN[1]) && b.recurring);
  return { amApproved, pmApproved, amPartial, pmPartial, amPending, pmPending, amRecurring, pmRecurring };
}

/* ── Rebuild user-side room buttons dynamically from accounts ── */
function rebuildUserRoomButtons(){

  const activeAccounts = zoomAccounts.filter(a => a.status === 'active');
  const uniqueCaps = [...new Set(activeAccounts.map(a => a.capacity))].sort((a,b)=>parseInt(a)-parseInt(b));

  // Sort accounts by numeric capacity ascending, then by name
  const sortedAccounts = activeAccounts.slice().sort((a,b)=>{
    const na = parseInt(a.capacity), nb = parseInt(b.capacity);
    if(na !== nb) return na - nb;
    return a.name.localeCompare(b.name);
  });

  // Color cycle for any number of capacity tiers
  const colorCycle = ['ic-b', 'ic-t', 'ic-p', 'ic-g', 'ic-y'];
  const fixedColorMap = { '100':'ic-b', '300':'ic-t', '500':'ic-p' };
  const usedColors = new Set(Object.values(fixedColorMap));
  const availableColors = colorCycle.filter(c => !usedColors.has(c));
  function getColorForCap(cap){
    if(fixedColorMap[cap]) return fixedColorMap[cap];
    const hash = parseInt(cap) % (availableColors.length || 1);
    return availableColors[hash] || colorCycle[parseInt(cap) % colorCycle.length];
  }

  const grid = document.getElementById('user-room-btns');
  grid.innerHTML = '';

  const fPax = document.getElementById('f-pax');
  const fAccount = document.getElementById('f-account');
  const prevPaxVal = fPax?.value;
  const prevAccountVal = fAccount?.value;
  if(fPax) fPax.innerHTML = '';
  if(fAccount) fAccount.innerHTML = '';

  sortedAccounts.forEach(acc => {
    const ic = getColorForCap(acc.capacity);
    const btn = document.createElement('div');
    btn.className = 'room-btn';
    btn.id = 'btn-'+acc.id;
    btn.setAttribute('onclick', `openCal('${acc.capacity}','${acc.id}')`);
    const expiringSoon = isExpiringSoon(acc);
    let expiryBadgeHtml = '';
    if(expiringSoon){
      const daysLeft = Math.ceil((new Date(acc.expiry+'T23:59:59') - new Date()) / (24*60*60*1000));
      const expiryStr = new Date(acc.expiry+'T00:00:00').toLocaleDateString('en-PH',{month:'short',day:'numeric'});
      const label = daysLeft<=7 ? `Expires ${expiryStr} (${daysLeft}d)` : 'Expiring soon';
      expiryBadgeHtml = `<div class="room-expiry-warn" title="License expires ${new Date(acc.expiry+'T00:00:00').toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'})}"><i class="ti ti-alert-triangle"></i> ${label}</div>`;
    }
    btn.innerHTML = `
      <div class="btn-icon ${ic}"><i class="ti ti-calendar-event"></i></div>
      <div class="btn-label">${acc.capacity} pax</div>
      <div class="btn-sub">${acc.name}</div>
      ${expiryBadgeHtml}`;
    grid.appendChild(btn);

    if(acc.id === activeAccountId) btn.classList.add('active');

    if(fAccount){
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = `${acc.name} — ${acc.capacity} pax`;
      fAccount.appendChild(opt);
    }
  });

  uniqueCaps.forEach(cap => {
    const opt = document.createElement('option');
    opt.value = cap;
    opt.textContent = cap + ' pax';
    if(fPax) fPax.appendChild(opt);
  });

  if(prevPaxVal && uniqueCaps.includes(prevPaxVal)) fPax.value = prevPaxVal;
  if(prevAccountVal && Array.from(fAccount.options).some(opt=>opt.value===prevAccountVal)) fAccount.value = prevAccountVal;
  if(fAccount && !fAccount.value && fAccount.options.length) fAccount.value = fAccount.options[0].value;

  if(fPax && fAccount){
    const selectedAccount = zoomAccounts.find(a=>a.id===fAccount.value);
    if(selectedAccount) fPax.value = selectedAccount.capacity;
  }

  // Also update export pax select
  const expPax = document.getElementById('exp-pax');
  if(expPax){
    expPax.innerHTML = '<option value="ALL">All Rooms</option>';
    uniqueCaps.forEach(cap => {
      expPax.innerHTML += `<option value="${cap}">${cap} pax</option>`;
    });
  }

  // Update the acc-capacity select in Add/Edit account modal to include any custom capacities
  const accCapEl = document.getElementById('acc-capacity');
  if(accCapEl){
    const allCapacities = [...new Set(zoomAccounts.map(a=>a.capacity))].sort((a,b)=>parseInt(a)-parseInt(b));
    const standardCaps = ['100','300','500'];
    const allUnique = [...new Set([...standardCaps, ...allCapacities])].sort((a,b)=>parseInt(a)-parseInt(b));
    const currentVal = accCapEl.value;
    accCapEl.innerHTML = allUnique.map(c=>`<option value="${c}">${c} pax</option>`).join('') +
      '<option value="custom">Custom…</option>';
    if(allUnique.includes(currentVal)) accCapEl.value = currentVal;
  }

  // Adjust responsive sizing based on number of room buttons
  adjustRoomSizes();
}

// Dynamically adjust the CSS variable controlling room button min-width
function adjustRoomSizes(){
  const grid = document.getElementById('user-room-btns');
  if(!grid) return;
  const count = grid.children.length || 0;
  // Choose a comfortable minimum width depending on count (smaller when many)
  let minW = 220;
  if(count <= 3) minW = 320;
  else if(count <= 6) minW = 260;
  else if(count <= 9) minW = 200;
  else if(count <= 12) minW = 170;
  else minW = 140;

  // Respect available container width: ensure at least 1 column fits
  const containerWidth = grid.clientWidth || document.documentElement.clientWidth;
  if(containerWidth && minW > containerWidth) minW = Math.max(120, Math.floor(containerWidth * 0.9));

  grid.style.setProperty('--room-min-width', minW + 'px');
}

// Recalculate sizes on window resize (debounced)
let __room_size_tmr = null;
window.addEventListener('resize', ()=>{
  clearTimeout(__room_size_tmr);
  __room_size_tmr = setTimeout(()=>adjustRoomSizes(), 120);
});

function renderCal(){
  if(!activePax) return;
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const { minDate, maxDate } = getBookingWindow();
  const firstDow = new Date(y, m, 1).getDay();
  const dim      = new Date(y, m+1, 0).getDate();
  const prevDim  = new Date(y, m, 0).getDate();

  document.getElementById('cal-month').textContent    = MONTHS[m] + ' ' + y;
  document.getElementById('cal-pax-badge').textContent = activePax + ' pax';
  document.getElementById('cal-window-badge').innerHTML = '<i class="ti ti-info-circle"></i> Bookable thru ' + MONTHS[maxDate.getMonth()] + ' ' + maxDate.getDate();

  let html = '';
  for(let i=firstDow-1;i>=0;i--)
    html += `<div class="cal-cell other-month"><div class="cal-dn">${prevDim-i}</div></div>`;

  for(let d=1;d<=dim;d++){
    const dObj   = new Date(y, m, d);
    const dow    = dObj.getDay();
    const dStr   = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday    = dObj.getTime()===minDate.getTime();
    const isPast     = dObj < minDate;
    const isViewOnly = dObj > maxDate;
    const isWeekend  = dow===0||dow===6;
    const slot       = getSlot(dStr, activePax, activeAccountId);

    let amCls = 'sb-empty';
    if(slot.amApproved) amCls='sb-full'; else if(slot.amPartial||slot.amPending) amCls='sb-partial';
    let pmCls = 'sb-empty';
    if(slot.pmApproved) pmCls='sb-full'; else if(slot.pmPartial||slot.pmPending) pmCls='sb-partial';
    const amRec = slot.amRecurring ? ' rec-border' : '';
    const pmRec = slot.pmRecurring ? ' rec-border' : '';

    let cc = 'cal-cell';
    if(isToday) cc+=' today';
    if(isPast) cc+=' past';
    if(isViewOnly) cc+=' view-only';
    if(isWeekend) cc+=' weekend';

    html += `<div class="${cc}" onclick="onDayClick('${dStr}','${activePax}','${activeAccountId||''}')">
      <div class="cal-dn">${d}</div>
      <div class="slot-bands">
        <div class="slot-band ${amCls}${amRec}"><div class="sb-dot"></div>AM</div>
        <div class="slot-band ${pmCls}${pmRec}"><div class="sb-dot"></div>PM</div>
      </div>
    </div>`;
  }

  const trailing = (firstDow+dim)%7===0?0:7-(firstDow+dim)%7;
  for(let i=1;i<=trailing;i++)
    html += `<div class="cal-cell other-month"><div class="cal-dn">${i}</div></div>`;

  document.getElementById('cal-days').innerHTML = html;
}

function changeMonth(dir){
  const today = new Date();
  const target = new Date(calMonth.getFullYear(), calMonth.getMonth()+dir, 1);
  const minNav = new Date(today.getFullYear(), today.getMonth()-3, 1);
  const maxNav = new Date(today.getFullYear(), today.getMonth()+18, 1);
  if(target<minNav || target>maxNav){ showToast('You can browse up to 18 months ahead for reference.','info'); return; }
  calMonth = target;
  renderCal();
}

function openCal(pax, accountId){
  if(activePax===pax && activeAccountId===accountId){ closeCal(); return; }
  document.querySelectorAll('.room-btn').forEach(b => { b.classList.remove('active'); });
  document.querySelectorAll('.viewing-badge').forEach(b => b.remove());
  activePax = pax;
  activeAccountId = accountId || null;
  const btn = document.getElementById('btn-'+(accountId || pax));
  if(btn){ btn.classList.add('active'); addBadge(accountId || pax); }
  document.getElementById('cal-wrap').classList.add('visible');
  renderCal();
  updateBookingFormAccountSelection();
}
function closeCal(){
  if(activeAccountId){
    const btn = document.getElementById('btn-'+activeAccountId);
    if(btn) btn.classList.remove('active');
    removeBadge(activeAccountId);
  } else if(activePax){
    const btn = document.getElementById('btn-'+activePax);
    if(btn) btn.classList.remove('active');
    removeBadge(activePax);
  }
  activePax=null;
  activeAccountId=null;
  document.getElementById('cal-wrap').classList.remove('visible');
  closeOverlay('book-overlay');
}
function addBadge(p){ removeBadge(p); const b=document.getElementById('btn-'+p); if(!b) return; const s=document.createElement('span'); s.className='viewing-badge'; s.id='badge-'+p; s.textContent='Viewing'; b.appendChild(s); }
function removeBadge(p){ const b=document.getElementById('badge-'+p); if(b) b.remove(); }

function onDayClick(dStr, pax, accountId){
  drawerDate = dStr;
  const dt = new Date(dStr+'T00:00:00');
  const label = DOW[dt.getDay()]+', '+MONTHS[dt.getMonth()]+' '+dt.getDate()+', '+dt.getFullYear();
  const { minDate, maxDate } = getBookingWindow();
  const withinWindow = dt >= minDate && dt <= maxDate;
  const isWeekend    = dt.getDay()===0 || dt.getDay()===6;
  const bookable     = withinWindow;

  document.getElementById('bm-title').textContent = label;
  document.getElementById('f-date').value = dStr;
  activeAccountId = accountId || activeAccountId;
  updateBookingFormAccountSelection();
  document.getElementById('f-date').min = toLocalISODate(minDate);
  document.getElementById('f-date').max = toLocalISODate(maxDate);

  document.querySelectorAll('.cal-cell').forEach(c=>c.classList.remove('selected'));
  document.querySelectorAll('.cal-cell').forEach(c=>{
    if(c.getAttribute('onclick')&&c.getAttribute('onclick').includes("'"+dStr+"'")) c.classList.add('selected');
  });

  const slot     = getSlot(dStr, pax, activeAccountId);
  const amFull   = slot.amApproved;
  const pmFull   = slot.pmApproved;
  const bothFull = amFull && pmFull;
  const canBook  = bookable && !bothFull;

  document.getElementById('bm-sub').textContent = canBook ? (pax+' pax room'+(isWeekend?' — weekend date':'')) :
    (!withinWindow ? 'View only — outside reservation window' :
     'Fully booked — view only');

  if(canBook){
    const currentAcc = document.getElementById('f-account').value;
    activeAccountId = currentAcc || activeAccountId;
  }

  const tabs = document.querySelectorAll('.m-tab');
  document.getElementById('view-only-note').style.display   = (!withinWindow) ? 'flex' : 'none';
  document.getElementById('full-note').style.display        = (bookable && bothFull) ? 'flex' : 'none';
  tabs[0].style.display = canBook ? '' : 'none';

  if(canBook){
    switchTab('form', tabs[0]);
    updateShiftAvailability(amFull, pmFull);
  } else {
    switchTab('existing', tabs[1]);
  }

  document.getElementById('book-overlay').classList.add('open');
}

function switchTab(tab, el){
  document.querySelectorAll('.m-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-form').style.display     = tab==='form'?'':'none';
  document.getElementById('tab-existing').style.display = tab==='existing'?'':'none';
  if(tab==='existing') renderExisting();
}
function renderExisting(){
  bookings = loadBookings();
  const el  = document.getElementById('existing-list');
  const rel = sortByNewest(bookings.filter(b => b.status!=='DENIED' && b.pax==activePax && (!activeAccountId || b.accountId===activeAccountId) && drawerDate && getEffDates(b).includes(drawerDate)));
  if(!rel.length){ el.innerHTML=`<div class="no-bk"><i class="ti ti-calendar-off"></i>No bookings for this date.</div>`; return; }
  el.innerHTML = rel.map(b=>`
    <div class="bk-card bk-${b.status.toLowerCase()}">
      <div class="bk-top"><div class="bk-title">${b.title}</div><span class="sp sp-${b.status.toLowerCase()}">${b.status}</span></div>
      <div class="bk-meta">
        <div>Name: <span>${b.name}</span></div>
        <div>Agency: <span>${b.agency}</span></div>
        <div>Shift: <span>${b.shift} (${b.start}–${b.end})</span></div>
        <div>Pax: <span>${b.pax}</span></div>
        <div>Registration: <span>${b.registration?'Required':'Not required'}</span></div>
        <div style="grid-column:1/-1">Security: <span>${securityLabel(b.security)}</span></div>
        ${b.recurring?`<div style="grid-column:1/-1">Recurring: <span>${recurLabel(b)}</span></div>`:''}
        ${b.notes?`<div style="grid-column:1/-1">Notes: <span>${b.notes}</span></div>`:''}
      </div>
    </div>`).join('');
}

function buildTimeSelects(){
  const hOpts = Array.from({length:12},(_,i)=>i+1).map(h=>`<option value="${h}">${h}</option>`).join('');
  const mOpts = ['00','15','30','45'].map(m=>`<option value="${m}">${m}</option>`).join('');
  ['f-start','f-end'].forEach(prefix=>{
    document.getElementById(prefix+'-h').innerHTML = hOpts;
    document.getElementById(prefix+'-m').innerHTML = mOpts;
  });
}
function timeTo12(t){
  let [H,M] = t.split(':').map(Number);
  const ap = H>=12 ? 'PM':'AM';
  let h12 = H%12; if(h12===0) h12=12;
  return { h:h12, m:String(M).padStart(2,'0'), ap };
}
function setTimeField(prefix, t){
  const { h, m, ap } = timeTo12(t);
  document.getElementById(prefix+'-h').value  = h;
  document.getElementById(prefix+'-m').value  = m;
  document.getElementById(prefix+'-ap').value = ap;
}
function getTimeField(prefix){
  let h = parseInt(document.getElementById(prefix+'-h').value,10) % 12;
  const m  = document.getElementById(prefix+'-m').value;
  const ap = document.getElementById(prefix+'-ap').value;
  if(ap==='PM') h += 12;
  return String(h).padStart(2,'0')+':'+m;
}
function onManualTimeChange(){
  selShiftV = document.querySelector('.shift-opt.sel')?.dataset.shift || selShiftV;
}

function selShift(el){
  document.querySelectorAll('.shift-opt').forEach(e=>e.classList.remove('sel'));
  el.classList.add('sel');
  selShiftV = el.dataset.shift;
  if(selShiftV==='AM')  { setTimeField('f-start','07:00'); setTimeField('f-end','12:00'); }
  if(selShiftV==='PM')  { setTimeField('f-start','13:00'); setTimeField('f-end','18:00'); }
  if(selShiftV==='BOTH'){ setTimeField('f-start','07:00'); setTimeField('f-end','18:00'); }
}
function toggleRecur(cb){
  document.getElementById('recur-box').classList.toggle('show',cb.checked);
  if(cb.checked) onFreqChange();
}
const DAY_ORDER = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function onFreqChange(){
  const freq = document.getElementById('f-freq').value;
  const wrap = document.getElementById('days-wrap');
  wrap.style.display = (freq==='weekly'||freq==='monthly') ? 'block' : 'none';
  const hint = document.getElementById('count-hint');
  hint.textContent = freq==='weekly' ? 'Number of weeks to repeat'
                    : freq==='monthly' ? 'Number of months to repeat'
                    : 'Total number of occurrences';
  if(freq==='weekly'||freq==='monthly') onDaysChange();
}
function getSelectedDays(){
  return DAY_ORDER.filter(d=>{
    const cb = document.querySelector(`.day-cb[value="${d}"]`);
    return cb && cb.checked && !cb.disabled;
  });
}
function onDaysChange(){
  const sel = getSelectedDays();
  document.getElementById('days-selected').textContent = sel.length ? `Selected: ${sel.join(', ')}` : 'Select at least one day';
}

function updateShiftAvailability(amFull, pmFull){
  const amOpt   = document.querySelector('.shift-opt[data-shift="AM"]');
  const pmOpt   = document.querySelector('.shift-opt[data-shift="PM"]');
  const bothOpt = document.querySelector('.shift-opt[data-shift="BOTH"]');
  amOpt.classList.toggle('disabled', amFull);
  pmOpt.classList.toggle('disabled', pmFull);
  bothOpt.classList.toggle('disabled', amFull || pmFull);
  if(!amFull)      selShift(amOpt);
  else if(!pmFull) selShift(pmOpt);
}

function validateFormDate(el){
  if(!el.value) return;
  // Weekends are allowed; a confirmation is shown at submit time instead of blocking here.
}
function submitBooking(){
  bookings = loadBookings();
  const name  =document.getElementById('f-name').value.trim();
  const agency=document.getElementById('f-agency').value.trim();
  const title =document.getElementById('f-title').value.trim();
  const date  =document.getElementById('f-date').value;
  const start = getTimeField('f-start');
  const end   = getTimeField('f-end');
  const pax   =document.getElementById('f-pax').value;
  const notes =document.getElementById('f-notes').value.trim();
  const recur =document.getElementById('recur-tog').checked;
  const registration = document.getElementById('reg-tog').checked;
  const security = document.getElementById('f-security').value;
  const accountId = activeAccountId;
  const freq  =document.getElementById('f-freq').value;
  const count =parseInt(document.getElementById('f-count').value)||1;
  const days  = (recur && (freq==='weekly'||freq==='monthly')) ? getSelectedDays() : [];

  if(!name||!agency||!title||!date){showToast('Please fill in all required fields.','error');return;}
  if(recur && (freq==='weekly'||freq==='monthly') && !days.length){showToast('Select at least one day to repeat on.','error');return;}

  const { minDate, maxDate } = getBookingWindow();
  const selDate = new Date(date+'T00:00:00');
  if(selDate<minDate){showToast('Date cannot be in the past.','error');return;}
  if(selDate>maxDate){showToast('Reservations are only accepted through '+MONTHS[maxDate.getMonth()]+' '+maxDate.getDate()+' for now.','error');return;}
  if(start>=end){showToast('End time must be after start time.','error');return;}

  const effDatesNew = recur ? getEffDates({date,recurring:recur,freq,count,days}) : [date];
  let conflict = null;
  outer:
  for(const b of bookings){
    if(b.status!=='APPROVED' || b.pax!=pax || (accountId && b.accountId!==accountId)) continue;
    const bDates = getEffDates(b);
    for(const d of effDatesNew){
      if(bDates.includes(d) && start < b.end && b.start < end){ conflict = b; break outer; }
    }
  }
  if(conflict){
    showToast(`Slot conflict: ${pax} pax already has an approved booking (${conflict.start}–${conflict.end}) overlapping this request.`,'error');
    return;
  }

  const bookingData = {name,agency,title,date,start,end,pax,notes,recur,accountId,freq,count,days,registration,security};

  // If any occurrence lands on a weekend, confirm with the requestor before proceeding.
  const weekendDates = effDatesNew.filter(d=>{ const dow=new Date(d+'T00:00:00').getDay(); return dow===0||dow===6; });
  if(weekendDates.length){
    _pendingBooking = bookingData;
    _pendingEffDates = effDatesNew;
    const fmt = d => new Date(d+'T00:00:00').toLocaleDateString('en-PH',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    const listHtml = weekendDates.length===1
      ? `<strong>${fmt(weekendDates[0])}</strong> falls on a weekend.`
      : `<strong>${weekendDates.length} of the requested dates</strong> fall on a weekend, including <strong>${fmt(weekendDates[0])}</strong>.`;
    document.getElementById('weekend-warn-text').innerHTML =
      `${listHtml} Weekend meetings are allowed, but please confirm this is intentional before submitting.`;
    document.getElementById('weekend-warn-ov').classList.add('open');
    return;
  }

  proceedAfterWeekendCheck(bookingData, effDatesNew);
}

function proceedAfterWeekendCheck(bookingData, effDatesNew){
  const { accountId, recur } = bookingData;
  // Warn if the meeting (or its last recurring occurrence) falls after the
  // Zoom account's license expiry date, instead of silently submitting it.
  const acc = getAccountById(accountId);
  if(acc && acc.expiry){
    const lastDate = effDatesNew[effDatesNew.length-1];
    if(new Date(lastDate+'T00:00:00') > new Date(acc.expiry+'T23:59:59')){
      _pendingBooking = bookingData;
      const expiryStr = new Date(acc.expiry+'T00:00:00').toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'});
      const lastDateStr = new Date(lastDate+'T00:00:00').toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'});
      document.getElementById('expiry-warn-text').innerHTML =
        `The <strong>${acc.name}</strong> (${acc.capacity} pax) account's license expires on <strong>${expiryStr}</strong> — before ${recur?'the last occurrence of ':''}this meeting on <strong>${lastDateStr}</strong>. If the account isn't renewed by then, this booking will become invalid. You can still submit it now for admin review.`;
      document.getElementById('expiry-warn-ov').classList.add('open');
      return;
    }
  }

  finalizeBookingSubmit(bookingData);
}

let _pendingBooking = null;
let _pendingEffDates = null;
function confirmWeekendContinue(){
  document.getElementById('weekend-warn-ov').classList.remove('open');
  if(!_pendingBooking) return;
  const bookingData  = _pendingBooking;
  const effDatesNew  = _pendingEffDates;
  _pendingBooking = null;
  _pendingEffDates = null;
  proceedAfterWeekendCheck(bookingData, effDatesNew);
}
function cancelWeekendWarn(){
  document.getElementById('weekend-warn-ov').classList.remove('open');
  _pendingBooking = null;
  _pendingEffDates = null;
}
function proceedWithBookingSubmit(){
  if(!_pendingBooking) return;
  finalizeBookingSubmit(_pendingBooking);
  _pendingBooking = null;
}

async function finalizeBookingSubmit(data){
  const {name,agency,title,date,start,end,pax,notes,recur,accountId,freq,count,days,registration,security} = data;
  bookings = loadBookings();
  const newId = 'BK-'+String(bookings.length+1).padStart(3,'0');
  const bk = {id:newId,title,name,agency,date,shift:selShiftV,start,end,pax,accountId,
    recurring:recur,freq:recur?freq:'',count:recur?count:0,days:(recur&&(freq==='weekly'||freq==='monthly'))?days:[],notes,
    registration:!!registration,security:security||'waiting_room_passcode',
    status:'PENDING',submitted:toLocalISODate(new Date())};

  bookings.unshift(bk);

  const btn = document.getElementById('submit-booking-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Submitting…'; }

  const saved = await saveBookings(bookings);

  if(btn){ btn.disabled = false; btn.textContent = 'Submit Request'; }

  if(!saved){
    // Roll back the optimistic local insert so the UI doesn't show a
    // "submitted" booking that never actually made it to the database.
    bookings = bookings.filter(b=>b.id!==newId);
    localStorage.setItem('zms_bookings', JSON.stringify(bookings));
    return; // pushBookingsToCloud already showed the error toast
  }

  // Email to admin is sent automatically server-side (see send-booking-email Edge Function)

  ['f-name','f-agency','f-title','f-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('recur-tog').checked=false;
  document.getElementById('recur-box').classList.remove('show');
  document.getElementById('reg-tog').checked=false;
  document.getElementById('f-security').value='waiting_room_passcode';
  document.getElementById('f-freq').value='weekly';
  document.getElementById('f-count').value=4;
  document.querySelectorAll('.day-cb').forEach(cb=>{ if(!cb.disabled) cb.checked=true; });
  onDaysChange();
  document.getElementById('days-wrap').style.display='none';

  showToast(`Request ${newId} submitted! Awaiting admin approval.`,'success');
  renderCal();
  switchTab('existing',document.querySelectorAll('.m-tab')[1]);
}

/* ═══════════════════════════════════════════════════════════
   ADMIN APP
   ═══════════════════════════════════════════════════════════ */
let activeFilter = 'ALL';

function adminLogin(){
  const p = document.getElementById('pass-inp').value;
  if(p===ADMIN_PASSWORD){
    adminAuthed = true;
    document.getElementById('login-err').style.display='none';
    document.getElementById('pass-inp').value='';
    showAdminPanel();
  } else {
    document.getElementById('login-err').style.display='block';
    document.getElementById('pass-inp').value='';
  }
}
function adminLogout(){
  adminAuthed = false;
  document.getElementById('admin-wrap').classList.remove('visible');
  document.getElementById('login-wrap').style.display='flex';
  stopReminderWatcher();
}
document.addEventListener('DOMContentLoaded', ()=>{
  const passInp = document.getElementById('pass-inp');
  if(passInp) passInp.addEventListener('keydown', e=>{ if(e.key==='Enter') adminLogin(); });
});

function showAdminPanel(){
  document.getElementById('login-wrap').style.display='none';
  document.getElementById('admin-wrap').classList.add('visible');
  initSettings();
  loadAdminBookings();
  zoomAccounts = loadAccounts();
  renderAccountsGrid();
  updateReminderUI();
  startReminderWatcher();
}

/* ── Admin Tab Navigation ── */
function switchAdminTab(tab, btn){
  document.querySelectorAll('.admin-tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.admin-panel').forEach(p=>p.style.display='none');
  document.getElementById('apanel-'+tab).style.display='';
  if(tab==='accounts'){ zoomAccounts=loadAccounts(); renderAccountsGrid(); }
  if(tab==='settings'){ initSettings(); }
}

/* ═══════════════════════════════════════════════════════════
   MEETING REMINDER ALARM
   Watches approved bookings (including recurring occurrences)
   while the admin panel is open, and fires an alarm (sound +
   on-screen banner + toast + optional desktop notification) at
   60, 30, and 15 minutes before each meeting's start time.
   ═══════════════════════════════════════════════════════════ */
const REMINDER_THRESHOLDS = [60, 30, 15]; // minutes-before-start checkpoints
const REMINDER_POLL_MS    = 20000;        // how often we check (20s)
let reminderWatcherId = null;

function getRemindersEnabled(){
  return localStorage.getItem('zms_reminders_enabled') !== '0'; // default: ON
}
function setRemindersEnabled(v){
  localStorage.setItem('zms_reminders_enabled', v ? '1' : '0');
}

/* Which (booking, date, threshold) alarms have already fired, so we
   never repeat one — persisted so a page refresh mid-countdown
   doesn't re-fire an alarm that already sounded. */
function getFiredReminders(){
  try{ return JSON.parse(localStorage.getItem('zms_fired_reminders')||'{}'); }
  catch(e){ return {}; }
}
function saveFiredReminders(obj){
  localStorage.setItem('zms_fired_reminders', JSON.stringify(obj));
}
function pruneFiredReminders(fired){
  const todayISO = toLocalISODate(new Date());
  Object.keys(fired).forEach(key=>{
    const datePart = key.split('__')[1];
    if(datePart && datePart < todayISO) delete fired[key];
  });
  return fired;
}

function startReminderWatcher(){
  if(reminderWatcherId) return; // already running
  checkMeetingReminders();
  reminderWatcherId = setInterval(checkMeetingReminders, REMINDER_POLL_MS);
}
function stopReminderWatcher(){
  if(reminderWatcherId){ clearInterval(reminderWatcherId); reminderWatcherId = null; }
}

function checkMeetingReminders(){
  if(!getRemindersEnabled()) return;
  const now      = new Date();
  const todayISO = toLocalISODate(now);
  const fired    = pruneFiredReminders(getFiredReminders());
  let changed    = false;

  bookings.forEach(b=>{
    if(b.status !== 'APPROVED' || !b.start) return;
    const effDates = getEffDates(b);
    if(!effDates.includes(todayISO)) return;

    const [h, m] = b.start.split(':').map(Number);
    const startDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    const diffMin = (startDt - now) / 60000;
    if(diffMin < -2) return; // already started, nothing to remind about

    REMINDER_THRESHOLDS.forEach(threshold=>{
      const key = `${b.id}__${todayISO}__${threshold}`;
      // Fire once diffMin drops to (or just below) the threshold. The
      // window is sized to comfortably straddle the poll interval.
      if(!fired[key] && diffMin <= threshold && diffMin > threshold - 2){
        fired[key] = true;
        changed = true;
        fireReminderAlarm(b, threshold);
      }
    });
  });

  if(changed) saveFiredReminders(fired);
}

function fireReminderAlarm(b, minutesBefore){
  const timeLbl = formatTimeLabel(b.start);
  playAlarmSound();
  showReminderBanner(b, minutesBefore, timeLbl);
  showToast(`⏰ "${b.title}" starts in ${minutesBefore} min (${timeLbl})`, 'info');
  flashReminderMuteBtn();
  if('Notification' in window && Notification.permission === 'granted'){
    try{
      new Notification('Meeting starting soon', {
        body: `"${b.title}" (${b.agency}) starts in ${minutesBefore} minutes at ${timeLbl}.`
      });
    }catch(e){ /* desktop notifications are best-effort */ }
  }
}

function formatTimeLabel(t){
  const { h, m, ap } = timeTo12(t);
  return `${h}:${m} ${ap}`;
}

/* Alarm sound: an admin-uploaded clip (stored as a data URL in
   localStorage) if one exists, otherwise a synthesized beep pattern
   via the Web Audio API — so the alarm always works out of the box,
   but any admin can swap in a real sound file with no code changes. */
const ALARM_SOUND_KEY = 'zms_alarm_sound_data';
const ALARM_SOUND_NAME_KEY = 'zms_alarm_sound_name';
function getCustomAlarmSound(){ return localStorage.getItem(ALARM_SOUND_KEY) || ''; }
function getCustomAlarmSoundName(){ return localStorage.getItem(ALARM_SOUND_NAME_KEY) || ''; }

function uploadAlarmSound(input){
  const file = input.files && input.files[0];
  if(!file) return;
  if(!file.type.startsWith('audio/')){ showToast('Please choose an audio file (mp3, wav, ogg…).','error'); input.value=''; return; }
  if(file.size > 2 * 1024 * 1024){ showToast('Please choose a short clip under 2MB — alarm sounds are stored in the browser.','error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      localStorage.setItem(ALARM_SOUND_KEY, reader.result);
      localStorage.setItem(ALARM_SOUND_NAME_KEY, file.name);
      updateReminderUI();
      showToast(`Alarm sound set to "${file.name}".`, 'success');
      playAlarmSound(); // preview immediately
    }catch(e){
      console.error('Could not save alarm sound:', e);
      showToast('Could not save that sound — it may be too large for browser storage.','error');
    }
  };
  reader.onerror = ()=> showToast('Could not read that audio file.','error');
  reader.readAsDataURL(file);
  input.value = '';
}
function resetAlarmSound(){
  localStorage.removeItem(ALARM_SOUND_KEY);
  localStorage.removeItem(ALARM_SOUND_NAME_KEY);
  updateReminderUI();
  showToast('Alarm sound reset to the default beep.', 'info');
}

function playAlarmSound(){
  const dataUrl = getCustomAlarmSound();
  const audioEl = document.getElementById('reminder-alarm-audio');
  if(dataUrl && audioEl){
    audioEl.src = dataUrl;
    audioEl.currentTime = 0;
    const playPromise = audioEl.play();
    if(playPromise && playPromise.catch){
      playPromise.catch(err=>{
        console.warn('Custom alarm sound could not play, falling back to beep:', err);
        playSynthesizedBeep();
      });
    }
    return;
  }
  playSynthesizedBeep();
}

/* Fallback beeping pattern — three short tones, no audio file needed. */
let reminderAudioCtx = null;
function playSynthesizedBeep(){
  try{
    reminderAudioCtx = reminderAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = reminderAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const beepTimes = [0, 0.32, 0.64]; // three short beeps
    beepTimes.forEach(offset=>{
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const startAt = ctx.currentTime + offset;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.28, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.22);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(startAt); osc.stop(startAt + 0.24);
    });
  }catch(e){ console.warn('Could not play reminder alarm sound:', e); }
}

function showReminderBanner(b, minutesBefore, timeLbl){
  const wrap = document.getElementById('reminder-banner-wrap');
  if(!wrap) return;
  const el = document.createElement('div');
  el.className = 'reminder-banner' + (minutesBefore <= 15 ? ' urgent' : '');
  el.innerHTML = `
    <div class="rb-ico"><i class="ti ti-bell-ringing"></i></div>
    <div class="rb-body">
      <div class="rb-title">Meeting starting in ${minutesBefore} minutes</div>
      <div class="rb-msg">${b.title}</div>
      <div class="rb-sub">${b.agency} · ${timeLbl} · ${b.pax} pax${b.recurring?' · Recurring':''}</div>
    </div>
    <button class="rb-close" onclick="this.closest('.reminder-banner').remove()"><i class="ti ti-x"></i></button>`;
  wrap.appendChild(el);
  setTimeout(()=>{ if(el.parentNode) el.remove(); }, 45000); // auto-dismiss after 45s
}

function flashReminderMuteBtn(){
  const btn = document.getElementById('reminder-mute-btn');
  if(!btn) return;
  btn.classList.add('ringing');
  setTimeout(()=>btn.classList.remove('ringing'), 6000);
}

/* Keep the topbar button + settings toggle in sync with each other. */
function updateReminderUI(){
  const enabled = getRemindersEnabled();
  const btn  = document.getElementById('reminder-mute-btn');
  const icon = document.getElementById('reminder-mute-icon');
  const lbl  = document.getElementById('reminder-mute-lbl');
  const tog  = document.getElementById('reminder-enabled-tog');
  if(btn && icon && lbl){
    btn.classList.toggle('muted', !enabled);
    icon.className = 'ti ' + (enabled ? 'ti-bell' : 'ti-bell-off');
    lbl.textContent = enabled ? 'Reminders On' : 'Reminders Off';
  }
  if(tog) tog.checked = enabled;
  const soundStatus = document.getElementById('alarm-sound-status');
  const resetBtn     = document.getElementById('alarm-sound-reset-btn');
  const customName   = getCustomAlarmSoundName();
  if(soundStatus) soundStatus.textContent = customName ? `Using "${customName}"` : 'Using default beep';
  if(resetBtn) resetBtn.style.display = customName ? '' : 'none';
  const notifBtn = document.getElementById('notif-perm-btn');
  if(notifBtn && 'Notification' in window){
    notifBtn.style.display = Notification.permission === 'granted' ? 'none' : '';
  }
}
function toggleReminderMute(){
  setRemindersEnabled(!getRemindersEnabled());
  updateReminderUI();
  showToast(getRemindersEnabled() ? 'Meeting reminder alarms enabled.' : 'Meeting reminder alarms muted.', 'info');
}
function onReminderToggleChange(cb){
  setRemindersEnabled(cb.checked);
  updateReminderUI();
  showToast(cb.checked ? 'Meeting reminder alarms enabled.' : 'Meeting reminder alarms muted.', 'info');
}
function testReminderAlarm(){
  playAlarmSound();
  showReminderBanner({ title:'Sample Meeting', agency:'Test Agency', pax:100, recurring:false }, 15, formatTimeLabel('09:00'));
  showToast('This is a test of the meeting reminder alarm.', 'info');
}
function requestNotifPermission(){
  if(!('Notification' in window)){ showToast('This browser does not support desktop notifications.', 'error'); return; }
  Notification.requestPermission().then(()=>{
    updateReminderUI();
    showToast(Notification.permission === 'granted' ? 'Desktop notifications enabled.' : 'Desktop notifications were not enabled.',
      Notification.permission === 'granted' ? 'success' : 'info');
  });
}

/* ── Settings ── */
function initSettings(){
  const emailEl = document.getElementById('admin-email-inp');
  const linkEl  = document.getElementById('share-link-inp');
  if(emailEl) emailEl.value = getAdminEmail();
  if(linkEl)  linkEl.value  = location.origin + location.pathname;
  updateReminderUI();
}
function saveAdminEmail(){
  const v = document.getElementById('admin-email-inp').value.trim();
  if(!v || !v.includes('@')){ showToast('Please enter a valid email address.','error'); return; }
  setAdminEmail(v);
  showToast('Notification email updated.','success');
}
function copyShareLink(){
  const inp = document.getElementById('share-link-inp');
  inp.select(); inp.setSelectionRange(0,99999);
  const done = ()=>showToast('Shareable link copied to clipboard!','success');
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(inp.value).then(done).catch(()=>document.execCommand('copy')&&done());
  } else {
    document.execCommand('copy'); done();
  }
}

/* ═══════════════════════════════════════════════════════════
   ZOOM ACCOUNTS MANAGEMENT
   ═══════════════════════════════════════════════════════════ */
function renderAccountsGrid(){
  zoomAccounts = loadAccounts();
  const grid = document.getElementById('accounts-grid');
  if(!grid) return;

  // Group by capacity
  const tiers = {};
  zoomAccounts.forEach(a => {
    if(!tiers[a.capacity]) tiers[a.capacity] = [];
    tiers[a.capacity].push(a);
  });

  const capacityOrder = Object.keys(tiers).sort((a,b)=>parseInt(a)-parseInt(b));

  if(!capacityOrder.length){
    grid.innerHTML = `<div class="accounts-empty"><i class="ti ti-video-off"></i><div>No Zoom accounts configured yet.</div><div style="font-size:11px;margin-top:4px;color:var(--text3);">Click "Add Account" to get started.</div></div>`;
    return;
  }

  grid.innerHTML = capacityOrder.map(cap => {
    const accounts = tiers[cap];
    const activeCount  = accounts.filter(a=>a.status==='active').length;
    const expiredCount = accounts.filter(a=>a.status==='expired').length;

    const rows = accounts.map(a => {
      const isExpired = a.status === 'expired';
      const expiryStr = a.expiry ? new Date(a.expiry+'T00:00:00').toLocaleDateString('en-PH',{year:'numeric',month:'short',day:'numeric'}) : '—';
      const isExpiringSoonFlag = isExpiringSoon(a);
      return `
        <div class="acc-row ${isExpired?'acc-expired':''}">
          <div class="acc-row-left">
            <div class="acc-status-dot ${isExpired?'dot-expired':'dot-active'}"></div>
            <div class="acc-info">
              <div class="acc-name">${a.name}</div>
              <div class="acc-meta-row">
                ${a.email ? `<span><i class="ti ti-mail" style="font-size:11px;"></i> ${a.email}</span>` : ''}
                <span><i class="ti ti-calendar" style="font-size:11px;"></i> Expiry: ${expiryStr}${isExpiringSoonFlag?` <span class="expiry-warn">Expiring soon</span>`:''}</span>
                ${a.notes ? `<span title="${a.notes}"><i class="ti ti-notes" style="font-size:11px;"></i> ${a.notes.length>40?a.notes.slice(0,40)+'…':a.notes}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="acc-row-right">
            <span class="acc-pill ${isExpired?'pill-expired':'pill-active'}">${isExpired?'Expired':'Active'}</span>
            <div class="acc-actions">
              ${!isExpired
                ? `<button class="a-btn" onclick="setAccountStatus('${a.id}','expired')" title="Mark as Expired"><i class="ti ti-clock-off"></i> Expire</button>`
                : `<button class="a-btn a-approve" onclick="setAccountStatus('${a.id}','active')" title="Reactivate"><i class="ti ti-rotate-clockwise"></i> Activate</button>`
              }
              <button class="a-btn" onclick="openEditAccountModal('${a.id}')" title="Edit"><i class="ti ti-pencil"></i> Edit</button>
              <button class="a-btn a-deny" onclick="openDeleteAccountModal('${a.id}')" title="Delete"><i class="ti ti-trash"></i></button>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="acc-tier-block">
        <div class="acc-tier-header">
          <div class="acc-tier-left">
            <div class="acc-tier-badge">${cap} pax</div>
            <div class="acc-tier-counts">
              <span class="tier-count-active">${activeCount} active</span>
              ${expiredCount ? `<span class="tier-count-expired">${expiredCount} expired</span>` : ''}
            </div>
          </div>
          <button class="ghost-btn" style="font-size:11px;" onclick="openAddAccountModal('${cap}')">
            <i class="ti ti-plus"></i> Add ${cap} pax account
          </button>
        </div>
        <div class="acc-list">${rows}</div>
      </div>`;
  }).join('');

  // Update user-side room buttons whenever accounts change
  rebuildUserRoomButtons();
}

/* Add Account Modal */
function openAddAccountModal(presetCapacity=''){
  document.getElementById('acc-modal-title').textContent = 'Add Zoom Account';
  document.getElementById('acc-modal-sub').textContent   = 'Register a new Zoom license for a department or team.';
  document.getElementById('acc-save-lbl').textContent    = 'Save Account';
  document.getElementById('acc-edit-id').value  = '';
  document.getElementById('acc-name').value     = '';
  document.getElementById('acc-status').value   = 'active';
  document.getElementById('acc-email').value    = '';
  document.getElementById('acc-expiry').value   = '';
  document.getElementById('acc-notes').value    = '';
  refreshCapacityOptions(presetCapacity || '100');
  document.getElementById('account-ov').classList.add('open');
}

/* Populate the capacity <select> with all known values + "Custom…" option */
function refreshCapacityOptions(selectVal){
  const el = document.getElementById('acc-capacity');
  if(!el) return;
  const existing = [...new Set(zoomAccounts.map(a=>a.capacity))].sort((a,b)=>parseInt(a)-parseInt(b));
  const standard = ['100','300','500'];
  const all = [...new Set([...standard,...existing])].sort((a,b)=>parseInt(a)-parseInt(b));
  el.innerHTML = all.map(c=>`<option value="${c}">${c} pax</option>`).join('') +
    '<option value="custom">Custom (enter below)…</option>';
  if(selectVal && all.includes(String(selectVal))) el.value = String(selectVal);
  else el.value = all[0] || '100';
  // Show/hide custom input
  toggleCustomCapInput();
}

function toggleCustomCapInput(){
  const sel = document.getElementById('acc-capacity');
  let customRow = document.getElementById('acc-capacity-custom-row');
  if(sel.value === 'custom'){
    if(!customRow){
      customRow = document.createElement('div');
      customRow.id = 'acc-capacity-custom-row';
      customRow.className = 'f-row';
      customRow.style.marginTop = '8px';
      customRow.innerHTML = '<div class="f-label">Custom Capacity (number of pax) <span class="f-req">*</span></div><input class="f-inp" id="acc-capacity-custom" type="number" min="1" max="99999" placeholder="e.g. 200">';
      sel.closest('.f-2').after(customRow);
    }
    customRow.style.display = '';
    document.getElementById('acc-capacity-custom').focus();
  } else {
    if(customRow) customRow.style.display = 'none';
  }
}

function openEditAccountModal(id){
  const a = zoomAccounts.find(a=>a.id===id);
  if(!a) return;
  document.getElementById('acc-modal-title').textContent = 'Edit Zoom Account';
  document.getElementById('acc-modal-sub').textContent   = 'Update the details for this Zoom license.';
  document.getElementById('acc-save-lbl').textContent    = 'Update Account';
  document.getElementById('acc-edit-id').value  = a.id;
  document.getElementById('acc-name').value     = a.name;
  document.getElementById('acc-status').value   = a.status;
  document.getElementById('acc-email').value    = a.email || '';
  document.getElementById('acc-expiry').value   = a.expiry || '';
  document.getElementById('acc-notes').value    = a.notes || '';
  refreshCapacityOptions(a.capacity);
  document.getElementById('account-ov').classList.add('open');
}

function saveAccount(){
  const editId   = document.getElementById('acc-edit-id').value.trim();
  const name     = document.getElementById('acc-name').value.trim();
  const capSel   = document.getElementById('acc-capacity').value;
  const capacity = capSel === 'custom'
    ? (document.getElementById('acc-capacity-custom')?.value?.trim() || '')
    : capSel;
  const status   = document.getElementById('acc-status').value;
  if(capSel === 'custom' && (!capacity || isNaN(parseInt(capacity)) || parseInt(capacity) < 1)){
    showToast('Please enter a valid custom capacity number.','error'); return;
  }
  const email    = document.getElementById('acc-email').value.trim();
  const expiry   = document.getElementById('acc-expiry').value;
  const notes    = document.getElementById('acc-notes').value.trim();

  if(!name){ showToast('Account name is required.','error'); return; }

  zoomAccounts = loadAccounts();

  if(editId){
    const idx = zoomAccounts.findIndex(a=>a.id===editId);
    if(idx>-1){
      zoomAccounts[idx] = {...zoomAccounts[idx], name, capacity, status, email, expiry, notes};
      showToast(`Account "${name}" updated.`,'success');
    }
  } else {
    const newAcc = { id:genAccountId(), name, capacity, status, email, expiry, notes, created:toLocalISODate(new Date()) };
    zoomAccounts.push(newAcc);
    showToast(`Account "${name}" (${capacity} pax) added.`,'success');
  }

  saveAccounts(zoomAccounts);
  closeOverlay('account-ov');
  renderAccountsGrid();
}

let pendingDeleteId = null;
function openDeleteAccountModal(id){
  const a = zoomAccounts.find(a=>a.id===id);
  if(!a) return;
  pendingDeleteId = id;
  document.getElementById('del-acc-name').textContent = `${a.name} (${a.capacity} pax)`;
  document.getElementById('delete-account-ov').classList.add('open');
}
function confirmDeleteAccount(){
  if(!pendingDeleteId) return;
  zoomAccounts = loadAccounts();
  const a = zoomAccounts.find(a=>a.id===pendingDeleteId);
  zoomAccounts = zoomAccounts.filter(a=>a.id!==pendingDeleteId);
  localStorage.setItem('zms_accounts', JSON.stringify(zoomAccounts));
  deleteAccountFromCloud(pendingDeleteId); // upsert alone can't remove rows, so delete explicitly
  showToast(`Account "${a?.name||''}" deleted.`,'info');
  pendingDeleteId = null;
  closeOverlay('delete-account-ov');
  renderAccountsGrid();
}

function setAccountStatus(id, status){
  zoomAccounts = loadAccounts();
  const a = zoomAccounts.find(a=>a.id===id);
  if(!a) return;
  let expiryWasCleared = false;
  if(status==='active' && a.expiry && new Date(a.expiry+'T23:59:59') < new Date()){
    // Its old expiry date is in the past, so activating it would just get
    // auto-expired again on the next load. Clear it so it stays active
    // until the admin sets a new expiry date via Edit.
    a.expiry = '';
    expiryWasCleared = true;
  }
  a.status = status;
  saveAccounts(zoomAccounts);
  showToast(
    expiryWasCleared
      ? `"${a.name}" reactivated. Its old expiry date was cleared — set a new one via Edit.`
      : `"${a.name}" marked as ${status}.`,
    status==='active'?'success':'info'
  );
  renderAccountsGrid();
}

/* ═══════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════ */
function populateExportMonths(){
  bookings = loadBookings();
  const months = new Set();
  bookings.forEach(b => months.add(b.date.slice(0,7)));
  const sorted = Array.from(months).sort();
  const sel = document.getElementById('exp-month');
  const opts = ['<option value="ALL">All Months</option>'];
  sorted.forEach(ym=>{
    const [y,mo] = ym.split('-');
    opts.push(`<option value="${ym}">${MONTHS[parseInt(mo,10)-1]} ${y}</option>`);
  });
  sel.innerHTML = opts.join('');
}
let exportFmt = 'xlsx';
function selectFmt(fmt, el){
  exportFmt = fmt;
  document.querySelectorAll('#fmt-xlsx,#fmt-csv').forEach(e=>e.classList.remove('sel'));
  el.classList.add('sel');
}
function openExportModal(){
  populateExportMonths();
  exportFmt = 'xlsx';
  document.getElementById('fmt-xlsx').classList.add('sel');
  document.getElementById('fmt-csv').classList.remove('sel');
  document.getElementById('export-ov').classList.add('open');
}
function exportToExcel(){
  if(typeof XLSX === 'undefined'){ showToast('Excel export library failed to load.','error'); return; }
  const month = document.getElementById('exp-month').value;
  const pax   = document.getElementById('exp-pax').value;
  const wantApproved = document.getElementById('exp-approved').checked;
  const wantDenied   = document.getElementById('exp-denied').checked;
  const wantPending  = document.getElementById('exp-pending').checked;
  const statuses = [];
  if(wantApproved) statuses.push('APPROVED');
  if(wantDenied)   statuses.push('DENIED');
  if(wantPending)  statuses.push('PENDING');
  if(!statuses.length){ showToast('Select at least one status to include.','error'); return; }
  bookings = loadBookings();
  const filtered = sortByNewest(bookings).filter(b=>(month==='ALL'||b.date.slice(0,7)===month)&&(pax==='ALL'||b.pax===pax)&&statuses.includes(b.status));
  if(!filtered.length){ showToast('No matching requests to export.','error'); return; }
  const rows = filtered.map(b=>({'ID':b.id,'Title':b.title,'Requestor':b.name,'Agency':b.agency,'Date':b.date,'Shift':b.shift,'Start':b.start,'End':b.end,'Pax Room':b.pax,'Recurring':b.recurring?recurLabel(b):'No','Registration':b.registration?'Required':'Not required','Security':securityLabel(b.security),'Status':b.status,'Submitted':b.submitted,'Notes':b.notes||''}));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols']=[{wch:9},{wch:26},{wch:16},{wch:18},{wch:11},{wch:7},{wch:7},{wch:7},{wch:9},{wch:14},{wch:14},{wch:24},{wch:10},{wch:11},{wch:24}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bookings');
  const fname=`zoom-bookings-${month==='ALL'?'all-months':month}-${pax==='ALL'?'all-pax':pax+'pax'}.xlsx`;
  XLSX.writeFile(wb, fname);
  showToast(`Exported ${filtered.length} request(s) to ${fname}`,'success');
  closeOverlay('export-ov');
}
function runExport(){
  if(exportFmt==='csv') exportToCSV(); else exportToExcel();
}
/* Generic array-of-objects -> CSV downloader */
function downloadCSV(rows, fname){
  const escape = v => { const s = String(v ?? ''); return s.includes(',')||s.includes('"')||s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s; };
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const csvRows = [headers.join(',')];
  rows.forEach(r => csvRows.push(headers.map(h => escape(r[h])).join(',')));
  const blob = new Blob([csvRows.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
function exportToCSV(){
  const month=document.getElementById('exp-month').value;
  const pax=document.getElementById('exp-pax').value;
  const wantApproved=document.getElementById('exp-approved').checked;
  const wantDenied=document.getElementById('exp-denied').checked;
  const wantPending=document.getElementById('exp-pending').checked;
  const statuses=[];
  if(wantApproved)statuses.push('APPROVED');
  if(wantDenied)statuses.push('DENIED');
  if(wantPending)statuses.push('PENDING');
  if(!statuses.length){showToast('Select at least one status.','error');return;}
  bookings=loadBookings();
  const filtered=sortByNewest(bookings).filter(b=>(month==='ALL'||b.date.slice(0,7)===month)&&(pax==='ALL'||b.pax===pax)&&statuses.includes(b.status));
  if(!filtered.length){showToast('No matching requests.','error');return;}
  const headers=['ID','Title','Requestor','Agency','Date','Shift','Start','End','Pax Room','Recurring','Registration','Security','Status','Submitted','Notes'];
  const escape=v=>{const s=String(v??'');return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}"`  :s;};
  const rows=[headers.join(',')];
  filtered.forEach(b=>rows.push([b.id,b.title,b.name,b.agency,b.date,b.shift,b.start,b.end,b.pax,b.recurring?recurLabel(b):'No',b.registration?'Required':'Not required',securityLabel(b.security),b.status,b.submitted,b.notes||''].map(escape).join(',')));
  const blob=new Blob([rows.join('\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const fname=`zoom-bookings-${month==='ALL'?'all-months':month}-${pax==='ALL'?'all-pax':pax+'pax'}.csv`;
  a.href=url;a.download=fname;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
  showToast(`Exported ${filtered.length} request(s) to ${fname}`,'success');
  closeOverlay('export-ov');
}

/* ── Bookings table ── */
function loadAdminBookings(){
  bookings = loadBookings();
  updateStats();
  renderTable();
}
function updateStats(){
  document.getElementById('st-total').textContent   = bookings.length;
  document.getElementById('st-pending').textContent = bookings.filter(b=>b.status==='PENDING').length;
  document.getElementById('st-approved').textContent= bookings.filter(b=>b.status==='APPROVED').length;
  document.getElementById('st-denied').textContent  = bookings.filter(b=>b.status==='DENIED').length;
  document.getElementById('fc-all').textContent     = bookings.length;
  document.getElementById('fc-pend').textContent    = bookings.filter(b=>b.status==='PENDING').length;
  document.getElementById('fc-app').textContent     = bookings.filter(b=>b.status==='APPROVED').length;
  document.getElementById('fc-den').textContent     = bookings.filter(b=>b.status==='DENIED').length;
}
function setFilter(btn){
  document.querySelectorAll('.f-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  activeFilter=btn.dataset.f;
  renderTable();
}
function renderTable(){
  const q=(document.getElementById('search-inp')?.value||'').toLowerCase();
  const filtered=sortByNewest(bookings).filter(b=>{
    const mf=activeFilter==='ALL'||b.status===activeFilter;
    const ms=!q||b.title.toLowerCase().includes(q)||b.name.toLowerCase().includes(q)||b.agency.toLowerCase().includes(q)||b.id.toLowerCase().includes(q);
    return mf&&ms;
  });
  const tbody=document.getElementById('req-tbody');
  if(!filtered.length){ tbody.innerHTML=`<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text3);">No requests found.</td></tr>`; return; }
  tbody.innerHTML=filtered.map(b=>`<tr>
    <td class="td-mono">${b.id}</td>
    <td><div class="td-title">${b.title}</div></td>
    <td>${b.name}</td>
    <td>${b.agency}</td>
    <td class="td-mono">${b.date}</td>
    <td><span style="font-family:monospace;font-size:11px;background:var(--surface2);padding:2px 7px;border-radius:3px;">${b.shift}</span></td>
    <td><span class="pax-chip">${b.pax}</span></td>
    <td>${b.recurring?`<span style="color:#6ba3e8;font-size:11px;">${recurLabel(b)}</span>`:'—'}</td>
    <td><span class="sp sp-${b.status.toLowerCase()}">${b.status}</span></td>
    <td><div class="act-grp">
      <button class="a-btn a-view" onclick="viewDetail('${b.id}')"><i class="ti ti-eye" style="font-size:13px;"></i></button>
      <button class="a-btn a-approve" onclick="updateStatus('${b.id}','APPROVED')" ${b.status==='APPROVED'?'disabled':''}><i class="ti ti-check" style="font-size:12px;"></i> Approve</button>
      <button class="a-btn a-deny" onclick="updateStatus('${b.id}','DENIED')" ${b.status==='DENIED'?'disabled':''}><i class="ti ti-x" style="font-size:12px;"></i> Deny</button>
    </div></td>
  </tr>`).join('');
}

function updateStatus(id, status){
  const b=bookings.find(b=>b.id===id); if(!b) return;
  const bDates = getEffDates(b);
  if(status==='APPROVED'){
    const acc = loadAccounts().find(a=>a.id===b.accountId);
    if(acc && acc.expiry){
      const lastDate = bDates[bDates.length-1];
      if(new Date(lastDate+'T00:00:00') > new Date(acc.expiry+'T23:59:59')){
        const expiryStr = new Date(acc.expiry+'T00:00:00').toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'});
        const lastDateStr = new Date(lastDate+'T00:00:00').toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'});
        document.getElementById('renew-needed-text').innerHTML =
          `The <strong>${acc.name}</strong> (${acc.capacity} pax) account's license expires on <strong>${expiryStr}</strong> — before ${b.recurring?'the last occurrence of ':''}request <strong>${b.id}</strong> on <strong>${lastDateStr}</strong>. Please renew the account's expiry date in Zoom Accounts before approving this request.`;
        document.getElementById('renew-needed-ov').classList.add('open');
        return;
      }
    }
    const clash=bookings.find(o=>o.id!==b.id&&o.status==='APPROVED'&&o.pax==b.pax&&o.accountId===b.accountId&&getEffDates(o).some(d=>bDates.includes(d))&&b.start<o.end&&o.start<b.end);
    if(clash){ showToast(`Can't approve ${b.id} — overlaps approved booking ${clash.id} on the same ${b.pax} pax account.`,'error'); return; }
  }
  b.status=status;
  let autoDenied=[];
  if(status==='APPROVED'){
    autoDenied=bookings.filter(o=>o.id!==b.id&&o.status==='PENDING'&&o.pax==b.pax&&o.accountId===b.accountId&&getEffDates(o).some(d=>bDates.includes(d))&&b.start<o.end&&o.start<b.end);
    autoDenied.forEach(o=>{ o.status='DENIED'; o.autoDeniedBy=b.id; });
  }
  saveBookings(bookings);
  updateStats();
  renderTable();
  if(status==='APPROVED'){
    let msg=`${b.id} approved — slot${b.recurring?' (recurring '+b.count+'×)':''} locked.`;
    if(autoDenied.length) msg+=` ${autoDenied.length} conflicting pending request${autoDenied.length>1?'s were':' was'} auto-denied (${autoDenied.map(o=>o.id).join(', ')}).`;
    showToast(msg,'success');
  } else {
    showToast(`${b.id} denied — slot freed.`,'info');
  }
}

function viewDetail(id){
  const b=bookings.find(b=>b.id===id); if(!b) return;
  document.getElementById('det-title').textContent=b.id+' — '+b.title;
  document.getElementById('det-body').innerHTML=`
    <div class="dg">
      <div><div class="df-lbl">Requestor</div><div class="df-val">${b.name}</div></div>
      <div><div class="df-lbl">Agency</div><div class="df-val">${b.agency}</div></div>
      <div><div class="df-lbl">Date</div><div class="df-val">${b.date}</div></div>
      <div><div class="df-lbl">Shift</div><div class="df-val">${b.shift} (${b.start}–${b.end})</div></div>
      <div><div class="df-lbl">Participants</div><div class="df-val">${b.pax} pax</div></div>
      <div><div class="df-lbl">Status</div><div class="df-val"><span class="sp sp-${b.status.toLowerCase()}">${b.status}</span></div></div>
      <div><div class="df-lbl">Registration</div><div class="df-val">${b.registration?'Required':'Not required'}</div></div>
      <div><div class="df-lbl">Security</div><div class="df-val">${securityLabel(b.security)}</div></div>
      <div style="grid-column:1/-1"><div class="df-lbl">Recurring</div><div class="df-val">${b.recurring?'Yes · '+recurLabel(b)+' recurrences':'No'}</div></div>
      ${b.autoDeniedBy?`<div style="grid-column:1/-1"><div class="df-lbl">Auto-Denied</div><div class="df-val" style="color:#f87171;">Conflicted with approved booking ${b.autoDeniedBy}</div></div>`:''}
      ${b.notes?`<div style="grid-column:1/-1"><div class="df-lbl">Notes</div><div class="df-val">${b.notes}</div></div>`:''}
      <div style="grid-column:1/-1"><div class="df-lbl">Submitted</div><div class="df-val" style="font-size:12px;color:var(--text2);">${b.submitted}</div></div>
    </div>`;
  document.getElementById('det-footer').innerHTML=`
    <button class="a-btn a-approve" style="padding:7px 14px;font-size:12px;" onclick="updateStatus('${b.id}','APPROVED');closeDetailModal();" ${b.status==='APPROVED'?'disabled':''}><i class="ti ti-check"></i> Approve</button>
    <button class="a-btn a-deny"    style="padding:7px 14px;font-size:12px;" onclick="updateStatus('${b.id}','DENIED');closeDetailModal();"   ${b.status==='DENIED'?'disabled':''}><i class="ti ti-x"></i> Deny</button>
    <button class="pri-btn" style="width:auto;padding:7px 14px;" onclick="closeDetailModal()">Close</button>`;
  document.getElementById('detail-ov').classList.add('open');
}
function closeDetailModal(){ document.getElementById('detail-ov').classList.remove('open'); }

/* ═══ INIT ═══ */
buildTimeSelects();
setTimeField('f-start','07:00');
setTimeField('f-end','12:00');
zoomAccounts = loadAccounts();
rebuildUserRoomButtons();
route();
