// =====================================================================
//  Demo mode: runs the real backend (Code.gs) inside the browser against a pretend spreadsheet saved
//  on this phone. Only loaded while KK_API in kk.js is blank. Not used once the Google Sheet is connected.
// =====================================================================
var KKDemo = (function(){
  var DB_KEY = 'kk_mock_db', api = null, sheets = {}, props = {}, cache = {};

  // ---- tiny synchronous SHA-256 / HMAC (Apps Script's Utilities has these built in) ----
  function utf8(s){ return Array.from(unescape(encodeURIComponent(s))).map(function(c){ return c.charCodeAt(0); }); }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256(bytes){
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var m = bytes.slice(), bl = bytes.length * 8; m.push(0x80);
    while(m.length % 64 !== 56) m.push(0);
    for(var i = 7; i >= 0; i--) m.push(i > 3 ? 0 : (bl >>> (i * 8)) & 255);
    var w = new Array(64), r = function(x, n){ return (x >>> n) | (x << (32 - n)); };
    for(var o = 0; o < m.length; o += 64){
      for(var t = 0; t < 16; t++) w[t] = (m[o+t*4] << 24) | (m[o+t*4+1] << 16) | (m[o+t*4+2] << 8) | m[o+t*4+3];
      for(t = 16; t < 64; t++){
        var s0 = r(w[t-15],7) ^ r(w[t-15],18) ^ (w[t-15] >>> 3), s1 = r(w[t-2],17) ^ r(w[t-2],19) ^ (w[t-2] >>> 10);
        w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0;
      }
      var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for(t = 0; t < 64; t++){
        var t1 = (h + (r(e,6) ^ r(e,11) ^ r(e,25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
        var t2 = ((r(a,2) ^ r(a,13) ^ r(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
      }
      H=[(H[0]+a)|0,(H[1]+b)|0,(H[2]+c)|0,(H[3]+d)|0,(H[4]+e)|0,(H[5]+f)|0,(H[6]+g)|0,(H[7]+h)|0];
    }
    var out = []; H.forEach(function(x){ out.push((x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255); }); return out;
  }
  function hmac(msg, key){
    var k = utf8(key); if(k.length > 64) k = sha256(k); while(k.length < 64) k.push(0);
    return sha256(k.map(function(b){ return b ^ 0x5c; }).concat(sha256(k.map(function(b){ return b ^ 0x36; }).concat(utf8(msg)))));
  }

  // ---- Apps Script services, just enough for Code.gs ----
  var pad = function(n){ return ('0'+n).slice(-2); }, MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var Utilities = {
    formatDate: function(d, tz, f){ d = new Date(d);
      var FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      return f.replace('yyyy', d.getFullYear()).replace('MMMM', '\u0001').replace('MMM', MON[d.getMonth()]).replace('MM', pad(d.getMonth()+1))
        .replace(/\bdd\b/, pad(d.getDate())).replace(/\bd\b/, d.getDate()).replace('HH', pad(d.getHours())).replace(/(^|[^H])H(?!H)/, '$1'+d.getHours())
        .replace(/mm/, pad(d.getMinutes())).replace(/(^|[^m])m(?!m)/, '$1'+d.getMinutes()).replace('\u0001', FULL[d.getMonth()]); },
    computeDigest: function(alg, s){ return sha256(utf8(String(s))); },
    computeHmacSha256Signature: function(s, k){ return hmac(String(s), String(k)); },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    getUuid: function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){ var r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }); },
    base64Decode: function(s){ return s; }, newBlob: function(b, t, n){ return { name: n, type: t, data: b }; }
  };
  function rng(sh, r, c, nr, nc){
    function get(){ var out = []; for(var i = 0; i < nr; i++){ var row = sh.data[r-1+i] || [], o = []; for(var j = 0; j < nc; j++) o.push(row[c-1+j] === undefined ? '' : row[c-1+j]); out.push(o); } return out; }
    return { getValues: get, getValue: function(){ return get()[0][0]; },
      getDisplayValues: function(){ return get().map(function(row){ return row.map(function(v){ return v instanceof Date ? Utilities.formatDate(v,'','HH:mm') : String(v); }); }); },
      setValues: function(v){ for(var i = 0; i < nr; i++){ sh.data[r-1+i] = sh.data[r-1+i] || []; for(var j = 0; j < nc; j++) sh.data[r-1+i][c-1+j] = v[i][j]; } return this; },
      setValue: function(v){ return this.setValues([[v]]); }, setFontWeight: function(){ return this; }, setNumberFormat: function(){ return this; } };
  }
  function mkSheet(name, data){
    return { name: name, data: data || [],
      getLastRow: function(){ return this.data.length; }, getLastColumn: function(){ return Math.max.apply(null, [0].concat(this.data.map(function(r){ return r.length; }))); },
      getMaxRows: function(){ return 1000; }, getMaxColumns: function(){ return 26; }, setFrozenRows: function(){},
      appendRow: function(r){ this.data.push(r.slice()); }, deleteRow: function(n){ this.data.splice(n-1, 1); },
      getDataRange: function(){ return rng(this, 1, 1, this.data.length, this.getLastColumn()); },
      getRange: function(a, b, c, d){ if(typeof a === 'string') return { setNumberFormat: function(){ return this; } }; return rng(this, a, b, c || 1, d || 1); } };
  }
  var ss = { getSheetByName: function(n){ return sheets[n] || null; }, insertSheet: function(n){ return (sheets[n] = mkSheet(n)); },
             setSpreadsheetTimeZone: function(){}, getSheets: function(){ return Object.keys(sheets).map(function(k){ return sheets[k]; }); }, deleteSheet: function(){} };
  var fid = 0;
  function folder(name){ var kids = {}; return { getFoldersByName: function(n){ var done = false; return { hasNext: function(){ return !done && !!kids[n]; }, next: function(){ done = true; return kids[n]; } }; },
    createFolder: function(n){ return (kids[n] = folder(n)); }, getUrl: function(){ return '#demo-folder'; }, getId: function(){ return name; },
    createFile: function(blob){ var id = 'demo' + Date.now() + (++fid); return { getId: function(){ return id; }, getUrl: function(){ return '#demo-photo'; },
      thumbUrl: function(){ return 'data:' + blob.type + ';base64,' + blob.data; }, setSharing: function(){} }; } }; }
  var root = folder('root');
  var env = {
    SpreadsheetApp: { getActive: function(){ return ss; }, getUi: function(){ throw new Error('no ui'); } },
    Utilities: Utilities,
    DriveApp: { createFolder: function(n){ return root.createFolder(n); }, getFolderById: function(){ return root; } },
    PropertiesService: { getScriptProperties: function(){ return { getProperty: function(k){ return props[k] || null; }, setProperty: function(k, v){ props[k] = v; } }; } },
    CacheService: { getScriptCache: function(){ return { get: function(k){ var c = cache[k]; return c && c.exp > Date.now() ? c.v : null; },
      put: function(k, v, s){ cache[k] = { v: v, exp: Date.now() + s*1000 }; }, remove: function(k){ delete cache[k]; } }; } },
    LockService: { getScriptLock: function(){ return { waitLock: function(){}, releaseLock: function(){} }; } },
    Session: { getEffectiveUser: function(){ return { getEmail: function(){ return 'demo@example.com'; } }; } },
    MailApp: { sendEmail: function(m){ try{ localStorage.setItem('kk_mock_lastmail', JSON.stringify({ subject: m.subject, at: Date.now() })); }catch(e){} } },
    ScriptApp: { getProjectTriggers: function(){ return [{ getHandlerFunction: function(){ return 'nightlySweep'; } }]; } },
    ContentService: { createTextOutput: function(s){ return { setMimeType: function(){ return JSON.parse(s); } }; }, MimeType: { JSON: 'json' } },
    Logger: { log: function(){} }
  };

  // ---- persistence (Dates survive as {$d: ms}) ----
  function save(){
    try{ localStorage.setItem(DB_KEY, JSON.stringify({ sheets: Object.keys(sheets).reduce(function(o, k){ o[k] = sheets[k].data; return o; }, {}), props: props },
      function(k, v){ return this[k] instanceof Date ? { $d: this[k].getTime() } : v; })); }catch(e){}
  }
  function load(){
    try{
      var raw = JSON.parse(localStorage.getItem(DB_KEY) || 'null', function(k, v){ return v && typeof v === 'object' && '$d' in v ? new Date(v.$d) : v; });
      if(!raw) return false;
      Object.keys(raw.sheets).forEach(function(k){ sheets[k] = mkSheet(k, raw.sheets[k]); }); props = raw.props || {};
      return true;
    }catch(e){ return false; }
  }

  function ymd(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  function seed(){
    api.setup();
    var us = sheets['Users']; us.data = [us.data[0]];
    var P = 'demo123';
    [['jay','Jay','admin'],['hazel','Hazel','admin'],['rebecca','Rebecca','manager'],['khin','Khin','crew'],['athirah','Athirah','crew'],['amir','Amir','crew'],['midzi','Midzi','crew']].forEach(function(u){
      var salt = Utilities.getUuid();
      api.logRow('users', { 'Username': u[0], 'Name': u[1], 'Role': u[2], 'Phone': '', 'Active': 'Y', 'Must change password': 'N',
        'Token version': 1, 'Password hash': api.hashPw(P, salt), 'Salt': salt, 'Created': ymd(new Date()) });
    });
    var t = new Date(), day = function(n){ var d = new Date(t); d.setDate(d.getDate() + n); return ymd(d); };
    api.logRow('events', { 'Event': 'Twilight (Suntec)', 'Location': 'Suntec Convention Centre', 'Start date': day(-1), 'End date': day(2), 'Colour': 'purple', 'Active': 'Y' });
    api.logRow('events', { 'Event': 'Tampines Bazaar', 'Location': 'Tampines Hub', 'Start date': day(-10), 'End date': day(20), 'Colour': 'green', 'Active': 'Y' });
    api.logRow('events', { 'Event': 'Jurong Bazaar', 'Location': 'Jurong East', 'Start date': day(3), 'End date': day(5), 'Colour': 'pink', 'Active': 'Y' });
    var n = 0, add = function(d, ev, un, s, e, type, note, lead){ api.logRow('roster', { 'ID': 'demo' + (++n), 'Date': day(d), 'Event': ev, 'Username': un, 'Start': s, 'End': e, 'Type': type || 'shift', 'Note': note || '', 'Updated by': 'jay', 'Lead': lead ? 'Y' : '' }); };
    add(0,'Twilight (Suntec)','hazel','10:00','18:00'); add(0,'Twilight (Suntec)','khin','14:00','22:00','','',true); add(0,'Twilight (Suntec)','athirah','16:00','22:00');
    add(0,'Tampines Bazaar','amir','15:00','22:00'); add(0,'','midzi','','','standby','after 5pm');
    add(1,'Twilight (Suntec)','hazel','11:30','22:00'); add(1,'Tampines Bazaar','amir','15:00','22:00'); add(1,'Tampines Bazaar','khin','17:00','22:00');
    add(2,'Twilight (Suntec)','athirah','11:30','22:30'); add(2,'Twilight (Suntec)','midzi','11:30','22:00'); add(2,'Tampines Bazaar','amir','15:00','22:00');
    add(-1,'Twilight (Suntec)','khin','11:00','22:00'); add(-1,'Tampines Bazaar','amir','15:00','22:00');
    // Stock: templates applied to events, opening stock sent to Twilight, and yesterday's closing count at Tampines (a few items low)
    var tpl = function(n){ return api.templateRows().filter(function(r){ return r.template === n; }); };
    [['Twilight (Suntec)','3-day event'],['Tampines Bazaar','Bazaar'],['Jurong Bazaar','3-day event']].forEach(function(x, i){
      api.setEventLevels(x[0], tpl(x[1])); sheets['Events'].data[i+1][6] = x[1];
    });
    for(var k in api._cache) delete api._cache[k];
    var stamp = function(dd, h){ var x = new Date(t); x.setDate(x.getDate()+dd); x.setHours(h, 0, 0, 0); return x; };
    var low = { 'Classic': 5, 'Cheesy': 3, 'Mentaiko': 0, 'Takeaway box': 1, 'Nutella': 0 };
    api.eventLevels('Twilight (Suntec)').forEach(function(s){
      api.logRow('stockLog', { 'Timestamp': stamp(-1, 9), 'Date': day(-1), 'Event': 'Twilight (Suntec)', 'Staff': 'rebecca', 'Category': s.category, 'Item': s.item, 'Unit': s.unit, 'Count': s.top, 'Minimum': s.min, 'Below minimum': '', 'Type': 'opening' });
    });
    api.eventLevels('Tampines Bazaar').forEach(function(s){
      var n = s.category.indexOf('8-piece') >= 0 && low[s.item] !== undefined ? low[s.item] : (low[s.item] !== undefined && s.category.indexOf('5-piece') < 0 ? low[s.item] : s.min + 1);
      api.logRow('stockLog', { 'Timestamp': stamp(-1, 22), 'Date': day(-1), 'Event': 'Tampines Bazaar', 'Staff': 'amir', 'Category': s.category, 'Item': s.item, 'Unit': s.unit, 'Count': n, 'Minimum': s.min, 'Below minimum': n < s.min ? 'Y' : '', 'Type': 'closing' });
    });
    // Pay rates, past shifts, closings with HitPay totals and cash bags, so payroll, cash and sales have something to show
    var rates = { rebecca:['monthly',3200], khin:['hourly',11], athirah:['hourly',10.5], amir:['hourly',11], midzi:['hourly',10] };
    sheets['Users'].data.forEach(function(r, i){ if(i && rates[r[0]]){ r[10] = rates[r[0]][0]; r[11] = rates[r[0]][1]; } });
    var crew = [['khin','Twilight (Suntec)',14,22],['athirah','Twilight (Suntec)',16,22],['amir','Tampines Bazaar',15,22],['midzi','Tampines Bazaar',17,22]];
    for(var dd = -12; dd <= -1; dd++){
      crew.forEach(function(c, j){
        if((dd + j) % 3 === 0) return;                              // not everyone works every day
        var tin = stamp(dd, c[2]); tin.setMinutes((j * 7 + dd * 3 + 60) % 13);
        var tout = stamp(dd, c[3]); tout.setMinutes((j * 11 + dd * 5 + 60) % 17);
        api.logRow('timesheet', { 'Date': day(dd), 'Staff': c[0], 'Event': c[1], 'Clock in': tin, 'Clock out': tout, 'Hours': Math.round((tout - tin) / 36e5 * 100) / 100,
          'Roster': pad(c[2])+':00–'+pad(c[3])+':00', 'Late (min)': tin.getMinutes() > 5 ? tin.getMinutes() : '', 'Prompt': 'Show a peace sign' });
      });
      ['Tampines Bazaar','Twilight (Suntec)'].forEach(function(ev, j){
        if(ev === 'Twilight (Suntec)' && dd < -2) return;           // Twilight only started recently
        var total = 600 + ((dd * 37 + j * 91 + 1200) % 450), paynow = Math.round(total * (0.55 + j * 0.1)), cash = total - paynow, orders = Math.round(total / 9.5);
        var counted = dd === -3 && ev === 'Tampines Bazaar' ? cash - 12 : cash, checked = dd <= -2;     // one closing came up $12 short
        api.logRow('closeLog', { 'Timestamp': stamp(dd, 22), 'Date': day(dd), 'Event': ev, 'Staff': ev === 'Tampines Bazaar' ? 'amir' : 'khin', 'Cash deposit': counted });
        var status = dd === -5 && ev === 'Tampines Bazaar' ? 'with closer' : dd < -4 ? 'banked' : dd < -1 ? 'received' : 'with closer';   // Amir still has one bag from 5 days ago (overdue)
        api.logRow('cash', { 'ID': 'cb' + dd + j, 'Date': day(dd), 'Event': ev, 'Closed by': ev === 'Tampines Bazaar' ? 'amir' : 'khin', 'Amount': counted, 'Status': status,
          'Received by': status !== 'with closer' ? 'rebecca' : '', 'Received at': status !== 'with closer' ? stamp(dd + 1, 11) : '', 'Received amount': status !== 'with closer' ? counted : '',
          'Banked by': status === 'banked' ? 'rebecca' : '', 'Banked at': status === 'banked' ? stamp(dd + 2, 14) : '', 'Banked amount': status === 'banked' ? counted : '', 'Slip': '', 'Notes': '',
          'HitPay total sales': checked ? total : '', 'HitPay cash sales': checked ? cash : '', 'PayNow sales': checked ? paynow : '', 'Orders': checked ? orders : '',
          'Sales checked by': checked ? 'rebecca' : '', 'Sales checked at': checked ? stamp(dd + 1, 10) : '', 'Cash difference': checked ? counted - cash : '',
          'Query': counted !== cash ? 'Cash in the bag $' + counted.toFixed(2) + ' vs HitPay cash sales $' + cash.toFixed(2) + ' (short $12.00)' : '', 'Reply': '', 'Query resolved': '' });
      });
    }
    api.logRow('notices', { 'ID': 'n1', 'Created': day(0), 'By': 'jay', 'Title': 'Welcome to the new staff app 🌭', 'Pinned': 'Y', 'Audience': 'All', 'Expires': '',
      'Must acknowledge': 'Y', 'Active': 'Y', 'Photo': '',
      'Body': 'From today, clock in and out here instead of the old QR form.\n\n- Scan the booth QR and log in\n- Take today\'s selfie check\n- Upload your opening evidence\n\nRead the **Handbook** when you have a quiet moment. Tap **Got it** below so we know you\'ve seen this.' });
    api.logRow('notices', { 'ID': 'n2', 'Created': day(0), 'By': 'rebecca', 'Title': 'Twilight: extra fryer oil in the van', 'Pinned': 'N', 'Audience': 'Twilight (Suntec)',
      'Expires': day(2), 'Must acknowledge': 'N', 'Active': 'Y', 'Photo': '', 'Body': 'Two oil tins are under the van seat. Bring one to the booth if oil runs low.' });
    api.logRow('claims', { 'ID': 'c1', 'Submitted': day(-1), 'Username': 'khin', 'Date': day(-1), 'Amount': 12.5, 'Category': 'Ingredients', 'Where': 'Twilight (Suntec)',
      'Description': '2 bags of ice from 7-Eleven', 'Receipt': '', 'Status': 'submitted' });
    api.logRow('claims', { 'ID': 'c2', 'Submitted': day(-3), 'Username': 'rebecca', 'Date': day(-3), 'Amount': 38.9, 'Category': 'Packaging', 'Where': 'Tampines Bazaar',
      'Description': 'Takeaway boxes (2 rolls)', 'Receipt': '', 'Status': 'approved', 'Decided by': 'jay', 'Decided at': day(-2) });
    save();
  }

  function boot(){
    if(api) return Promise.resolve();
    return fetch('Code.gs', { cache: 'no-store' }).then(function(r){ return r.text(); }).then(function(src){
      var names = Object.keys(env);
      api = new Function(names.join(','), src + '\n;return { setup: setup, doPost: doPost, doGet: doGet, logRow: logRow, hashPw: hashPw, setEventLevels: setEventLevels, templateRows: templateRows, eventLevels: eventLevels, _cache: _cache };')
        .apply(null, names.map(function(n){ return env[n]; }));
      if(!load()) seed();
    });
  }
  function run(fn){
    return boot().then(function(){
      for(var k in api._cache) delete api._cache[k];
      var out = fn(); save(); return out;
    });
  }
  return {
    post: function(body){ return run(function(){ return api.doPost({ postData: { contents: JSON.stringify(body) } }); }); },
    config: function(){ return run(function(){ return api.doGet({ parameter: {} }); }); },
    reset: function(){ try{ Object.keys(localStorage).forEach(function(k){ if(k.indexOf('kk_') === 0) localStorage.removeItem(k); }); }catch(e){} }
  };
})();
