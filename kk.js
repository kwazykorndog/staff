// =====================================================================
//  Kwazy Korndog staff app — shared settings & helpers
// =====================================================================
//  Paste your Google Apps Script web-app URL below (it ends in /exec).
//  While it's blank, the app runs in DEMO MODE: the real backend runs in your browser with sample data.
var KK_API = 'https://script.google.com/macros/s/AKfycbxSMgWw_XTc2uMbmJ7Yo0AvxB8FUXjxa5g2AYRWRUfKXREIlBPzMuKZjSQZHQu2aym3RQ/exec';
// =====================================================================

var KK = (function(){
  var api = KK_API;
  var ov = new URLSearchParams(location.search).get('api');   // ?api=<test /exec URL> for testing
  if(ov) api = ov;
  var DEMO = !api;

  function ymd(){ var d=new Date(); return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function hhmm(d){ d = d||new Date(); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function mem(k,v){
    try{ if(v===undefined) return localStorage.getItem('kk_'+k)||''; if(v===null) localStorage.removeItem('kk_'+k); else localStorage.setItem('kk_'+k,v); }catch(e){ return ''; }
  }
  function money(n){ return (n<0?'−$':'$') + Math.abs(n).toFixed(2); }

  // ---- demo backend (loaded on demand) ----
  var demoReady = null;
  function demo(){
    if(!demoReady) demoReady = new Promise(function(ok, fail){
      var s = document.createElement('script'); s.src = 'demo.js'; s.onload = function(){ ok(window.KKDemo); }; s.onerror = fail;
      document.head.appendChild(s);
    });
    return demoReady;
  }

  var cfg = null;
  function config(){
    if(cfg) return cfg;
    cfg = DEMO ? demo().then(function(d){ return d.config(); })
               : fetch(api+'?action=config').then(function(r){ return r.json(); });
    cfg = cfg.then(function(res){ if(!res.ok) throw new Error(res.error||'Could not load'); return res; });
    cfg.catch(function(){ cfg = null; });   // allow a retry after a network hiccup
    return cfg;
  }

  // ---- session ----
  function session(){ try{ return JSON.parse(mem('session')||'null'); }catch(e){ return null; } }
  function setSession(token, user){ mem('session', JSON.stringify({token:token, user:user})); }
  function user(){ var s = session(); return s ? s.user : null; }
  function logout(){ mem('session', null); mem('clockin', null); location.href = 'login.html'; }
  // Call at the top of each page. Sends people to the login page if needed; returns the user.
  function requireLogin(roles){
    var u = user();
    if(!u){ location.href = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search); return null; }
    if(u.mustChange){ location.href = 'login.html?change=1'; return null; }
    if(roles && roles.indexOf(u.role) < 0){ location.href = 'index.html'; return null; }
    return u;
  }

  function post(action, data){
    var s = session(), body = Object.assign({action:action, token: s ? s.token : ''}, data||{});
    var p = DEMO ? demo().then(function(d){ return d.post(body); })
                 : fetch(api,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body)}).then(function(r){ return r.json(); });
    return p.then(function(res){
      if(res && res.auth && action !== 'login'){ logout(); }
      else if(res && res.mustChange){ location.href = 'login.html?change=1'; }
      if(res && res.token && res.user) setSession(res.token, res.user);
      return res;
    });
  }

  function demoBanner(){
    if(!DEMO) return;
    var d=document.createElement('div'); d.className='demo';
    d.innerHTML='Demo · log in as <b>jay</b> (admin), <b>rebecca</b> (manager) or <b>khin</b> (crew) · password <b>demo123</b> · <a href="#" id="demoReset">Reset demo</a>';
    document.body.insertBefore(d, document.body.firstChild);
    document.getElementById('demoReset').onclick = function(e){
      e.preventDefault();
      try{ Object.keys(localStorage).forEach(function(k){ if(k.indexOf('kk_')===0) localStorage.removeItem(k); }); }catch(err){}
      location.href = 'login.html';
    };
  }
  document.addEventListener('DOMContentLoaded', demoBanner);

  // Shrink a camera photo on the phone before upload. Resolves to a JPEG data URL (default ~1280px, about 200 KB).
  function shrink(file, max, q){
    max = max || 1280;
    return new Promise(function(ok, fail){
      var img = new Image(), url = typeof file==='string' ? file : URL.createObjectURL(file);
      img.onload = function(){
        var k = Math.min(1, max/Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width*k); cv.height = Math.round(img.height*k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        if(typeof file!=='string') URL.revokeObjectURL(url);
        ok(cv.toDataURL('image/jpeg', q || 0.72));
      };
      img.onerror = function(){ fail(new Error('bad image')); };
      img.src = url;
    });
  }

  // Today's clock-in on this phone: {event, time}. Pass an object to save, null to clear.
  function clockIn(v){
    if(v!==undefined) return mem('clockin', v ? JSON.stringify(Object.assign({date:ymd()}, v)) : null);
    try{ var c = JSON.parse(mem('clockin')||'null'); return c && c.date===ymd() ? c : null; }catch(e){ return null; }
  }

  function today(){ return new Date().toLocaleDateString('en-SG',{weekday:'short',day:'numeric',month:'short'}); }

  // Event colours, shared by the roster, live view and hub
  var COLOURS = { green:['#e4f3d9','#2e5a12'], purple:['#ebe8fc','#3d3489'], orange:['#fde7d6','#8a3d0c'], pink:['#fde3ee','#8a2350'],
                  blue:['#e1effb','#0c447c'], yellow:['#fdf3cf','#7a5a00'], teal:['#dcf3ec','#0b5c48'], grey:['#eeecea','#4a4744'] };
  function colour(c){ var x = COLOURS[c] || COLOURS.grey; return 'background:'+x[0]+';color:'+x[1]; }

  function isMgr(u){ u = u || user(); return !!u && (u.role === 'admin' || u.role === 'manager'); }

  // Tiny formatter for notices and the handbook: **bold**, "- " bullets, "1. " numbered lines, blank line = new paragraph.
  function rich(text){
    var html = '', list = '';
    String(text||'').split('\n').forEach(function(line){
      var t = esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'), m;
      if((m = line.match(/^- (.*)/))){ if(list !== 'ul'){ html += (list ? '</'+list+'>' : '') + '<ul>'; list = 'ul'; } html += '<li>'+t.slice(2)+'</li>'; return; }
      if((m = line.match(/^(\d+)\. /))){ if(list !== 'ol'){ html += (list ? '</'+list+'>' : '') + '<ol>'; list = 'ol'; } html += '<li value="'+m[1]+'">'+t.replace(/^\d+\. /,'')+'</li>'; return; }
      if(list){ html += '</'+list+'>'; list = ''; }
      if(line.trim()) html += '<p>'+t+'</p>';
    });
    return html + (list ? '</'+list+'>' : '');
  }

  // ---- bottom tab bar ----
  var ICON = {
    today:  '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    notices:'<path d="M4 10v4h3l6 4V6L7 10H4z"/><path d="M16.5 9a4 4 0 010 6"/><path d="M19 6.5a7.5 7.5 0 010 11"/>',
    learn:  '<path d="M4 5.5A2.5 2.5 0 016.5 3H20v15H6.5A2.5 2.5 0 004 20.5z"/><path d="M4 20.5A2.5 2.5 0 016.5 18H20v3H6.5"/><path d="M9 7.5h7M9 11h5"/>',
    me:     '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
    manage: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>'
  };
  function nav(active){
    var u = user(); if(!u || document.querySelector('.tabbar')) return;
    var items = [['today','index.html','Today'],['notices','notices.html','Notices'],['learn','handbook.html','Learn'],['me','me.html','Me']];
    if(isMgr(u)) items.push(['manage','admin.html','Manage']);
    var n = document.createElement('nav'); n.className = 'tabbar';
    n.innerHTML = items.map(function(it){
      return '<a href="'+it[1]+'" class="'+(it[0]===active?'on':'')+'"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+
        ICON[it[0]]+'</svg><span class="nb" id="nb_'+it[0]+'"></span></span>'+it[2]+'</a>'; }).join('');
    document.body.appendChild(n); document.body.classList.add('has-tabbar');
    counts().then(badges);
  }
  // Badge counts, cached for a minute so moving between tabs stays quick.
  function counts(fresh){
    try{ var c = JSON.parse(sessionStorage.getItem('kk_counts')||'null'); if(c && !fresh && Date.now() - c.t < 60000) return Promise.resolve(c); }catch(e){}
    return post('me').then(function(m){ return m.ok ? setCounts(m) : {}; }, function(){ return {}; });
  }
  function setCounts(m){
    var c = {t:Date.now(), notices:m.unreadNotices||0, learn:m.handbookToRead||0, manage:(m.pendingClaims||0)+(m.restock||0)+(m.cash?(m.cash.overdue||[]).length+(m.cash.toVerify||0):0),
             me:m.myCash ? m.myCash.count : 0};
    try{ sessionStorage.setItem('kk_counts', JSON.stringify(c)); }catch(e){}
    badges(c); return c;
  }
  function badges(c){
    ['notices','learn','manage','me'].forEach(function(k){ var el = document.getElementById('nb_'+k); if(el){ el.textContent = c[k] > 9 ? '9+' : (c[k] || ''); el.style.display = c[k] ? 'flex' : 'none'; } });
  }

  return { DEMO:DEMO, isMgr:isMgr, rich:rich, nav:nav, counts:counts, setCounts:setCounts, esc:esc, mem:mem, money:money, config:config, post:post, hhmm:hhmm, ymd:ymd,
           today:today, shrink:shrink, clockIn:clockIn, user:user, logout:logout, requireLogin:requireLogin,
           setSession:setSession, colour:colour, COLOURS:COLOURS };
})();
