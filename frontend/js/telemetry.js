/* ── JetseaAI Fleet Monitor — 遙測 WebSocket & HUD ──────────────────────── */

(function initTelemetry(){
  const MAX_RPM = 3000;
  const TRACK_MAX = 300;
  let ws, retryTimer, hasData = false;
  let currentVesselId = '';   // 目前訂閱遙測的船隻 ID

  // ── 小地圖初始化 ────────────────────────────────────────────────────────────
  let map = null, vesselMarker = null, trackLine = null;
  const trackCoords = [];

  // ── 使用者位置（GPS 即時）+ 測量圖釘 ─────────────────────────────────────
  let myLocMarker = null, myLocLine = null;
  let myLat = null, myLon = null;
  let geoWatchId = null;
  // 測量圖釘
  let pinMarker = null, pinLine = null;
  let pinLat = null, pinLon = null;
  let pinEditMode = false;

  function initMap(){
    if(map) return;
    map = L.map('minimap', {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
    }).setView([23.5, 120.0], 12);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);

    const icon = L.divIcon({
      className: 'vessel-icon',
      html: '<div class="vessel-dot"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    vesselMarker = L.marker([23.5, 120.0], {icon, zIndexOffset: 1000}).addTo(map);

    trackLine = L.polyline([], {
      color: '#f0a500',
      weight: 2,
      opacity: 0.6,
      smoothFactor: 1,
    }).addTo(map);

    // ── 使用者位置：marker + 連線 ──────────────────────────────────────────
    const myIcon = L.divIcon({
      className: 'my-loc-icon',
      html: '<div class="my-loc-dot"></div><div class="my-loc-ring"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    myLocMarker = L.marker([0, 0], {icon: myIcon, zIndexOffset: 900}).addTo(map);
    myLocMarker.setOpacity(0);

    myLocLine = L.polyline([], {
      color: 'rgba(66,133,244,.45)',
      weight: 1.5,
      dashArray: '6,6',
      interactive: false,
    }).addTo(map);

    // ── 測量圖釘：marker + 連線 ─────────────────────────────────────────
    const pinIcon = L.divIcon({
      className: 'pin-icon',
      html: '<div class="pin-dot"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    pinMarker = L.marker([0, 0], {icon: pinIcon, zIndexOffset: 800}).addTo(map);
    pinMarker.setOpacity(0);

    pinLine = L.polyline([], {
      color: 'rgba(255,61,87,.5)',
      weight: 1.5,
      dashArray: '5,5',
      interactive: false,
    }).addTo(map);

    // ── 點擊地圖放置測量圖釘 ────────────────────────────────────────────
    map.on('click', (ev) => {
      if(!pinEditMode) return;
      placePin(ev.latlng.lat, ev.latlng.lng);
      togglePinEditMode(false);
    });

    // 載入已儲存的圖釘 & 啟動 GPS
    loadPinFromStorage();
    startGpsWatch();

    const btn = document.getElementById('minimap-toggle');
    const wrap = document.getElementById('minimap-wrap');
    if(btn && wrap){
      btn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        wrap.classList.toggle('hidden');
        btn.textContent = wrap.classList.contains('hidden') ? '🗺' : '✕';
        if(wrap.classList.contains('hidden')){
          btn.style.cssText = 'position:absolute;top:12px;left:14px;z-index:9;width:28px;height:28px;background:rgba(8,14,24,.8);border:1px solid rgba(240,165,0,.25);border-radius:3px;color:rgba(240,165,0,.6);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;pointer-events:all;transition:all .15s;';
          document.getElementById('stage').appendChild(btn);
        } else {
          btn.style.cssText = 'position:absolute;right:4px;top:4px;z-index:2;width:22px;height:22px;background:rgba(8,14,24,.8);border:1px solid rgba(240,165,0,.25);border-radius:3px;color:rgba(240,165,0,.6);font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;pointer-events:all;transition:all .15s;';
          wrap.appendChild(btn);
          map.invalidateSize();
        }
      });

      /* ── 小地圖拖曳（從座標列拖動）─────────────────────────── */
      let mDrag=false, mDx=0, mDy=0;
      const coordBar=document.getElementById('map-coord-bar');
      (coordBar||wrap).addEventListener('mousedown', (ev)=>{
        // 只從座標列觸發拖曳；忽略 resize / toggle
        if(ev.target.closest('#minimap-rsz') || ev.target.closest('#minimap-toggle')) return;
        if(coordBar && !coordBar.contains(ev.target)) return;
        mDrag=true;
        const r=wrap.getBoundingClientRect();
        mDx=ev.clientX-r.left; mDy=ev.clientY-r.top;
        wrap.style.cursor='grabbing';
        ev.preventDefault();
      });
      document.addEventListener('mousemove', (ev)=>{
        if(!mDrag) return;
        const stage=document.getElementById('stage').getBoundingClientRect();
        let x=ev.clientX-stage.left-mDx, y=ev.clientY-stage.top-mDy;
        x=Math.max(0, Math.min(x, stage.width-wrap.offsetWidth));
        y=Math.max(0, Math.min(y, stage.height-wrap.offsetHeight));
        wrap.style.left=x+'px'; wrap.style.top=y+'px';
      });
      document.addEventListener('mouseup', ()=>{ if(mDrag){mDrag=false; wrap.style.cursor='';} });

      /* ── 小地圖縮放 ─────────────────────────────────────────── */
      const rsz=document.getElementById('minimap-rsz');
      if(rsz){
        let mRes=false, mRsx=0, mRsy=0, mRsw=0, mRsh=0;
        rsz.addEventListener('mousedown', (ev)=>{
          mRes=true;
          mRsx=ev.clientX; mRsy=ev.clientY;
          mRsw=wrap.offsetWidth; mRsh=wrap.offsetHeight;
          ev.stopPropagation(); ev.preventDefault();
        });
        document.addEventListener('mousemove', (ev)=>{
          if(!mRes) return;
          const w=Math.max(200, Math.min(mRsw+(ev.clientX-mRsx), 700));
          const h=Math.max(140, Math.min(mRsh+(ev.clientY-mRsy), 600));
          wrap.style.width=w+'px'; wrap.style.height=h+'px';
          map.invalidateSize();
        });
        document.addEventListener('mouseup', ()=>{ if(mRes){mRes=false;} });
      }

      /* ── 「測量圖釘」按鈕 ──────────────────────────────────── */
      const myLocBtn = document.getElementById('my-loc-btn');
      if(myLocBtn){
        myLocBtn.addEventListener('click', (ev)=>{
          ev.stopPropagation();
          togglePinEditMode();
        });
      }
      const pinRemoveBtn = document.getElementById('pin-remove-btn');
      if(pinRemoveBtn){
        pinRemoveBtn.addEventListener('click', (ev)=>{
          ev.stopPropagation();
          removePin();
        });
      }
    }
  }

  function updateMapPosition(lat, lon){
    if(!map) return;
    vesselMarker.setLatLng([lat, lon]);
    trackCoords.push([lat, lon]);
    if(trackCoords.length > TRACK_MAX) trackCoords.shift();
    trackLine.setLatLngs(trackCoords);

    // 更新連線 & 距離（GPS + 圖釘）
    updateMyLocLine();
    updateGpsDistance();
    updatePinLine();
    updatePinDistance();

    // 自動平移：若船隻和使用者都有座標，fitBounds 兩者；否則跟蹤船隻
    if(myLat !== null){
      const bounds = L.latLngBounds([[lat, lon], [myLat, myLon]]);
      // 只在第一筆資料或超出視窗時才 fitBounds
      if(trackCoords.length === 1){
        map.fitBounds(bounds.pad(0.3), {animate: true, maxZoom: 14});
      }
    } else {
      const center = map.getCenter();
      const dist = map.distance([lat,lon], [center.lat, center.lng]);
      const pixelBound = map.getSize().x * 0.35;
      const meterPerPixel = map.options.crs.scale(map.getZoom()) > 0
        ? 40075016.686 * Math.cos(lat * Math.PI/180) / (256 * Math.pow(2, map.getZoom()))
        : 1;
      if(trackCoords.length === 1 || dist > pixelBound * meterPerPixel){
        map.panTo([lat, lon], {animate: true, duration: 0.8});
      }
    }
  }

  function clearTrack(){
    trackCoords.length = 0;
    if(trackLine) trackLine.setLatLngs([]);
  }

  // ── GPS 即時追蹤（初始化即啟動）─────────────────────────────────────────
  function startGpsWatch(){
    if(!navigator.geolocation) return;
    if(geoWatchId !== null) return;
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        myLat = pos.coords.latitude;
        myLon = pos.coords.longitude;
        if(myLocMarker){
          myLocMarker.setLatLng([myLat, myLon]);
          myLocMarker.setOpacity(1);
        }
        updateMyLocLine();
        updateGpsDistance();
        // 更新座標顯示
        const el1 = document.getElementById('my-loc-lat');
        const el2 = document.getElementById('my-loc-lon');
        if(el1) el1.textContent = myLat.toFixed(6) + '°';
        if(el2) el2.textContent = myLon.toFixed(6) + '°';
      },
      (err) => { console.warn('[GPS]', err.message); },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  }

  // ── 測量圖釘 ──────────────────────────────────────────────────────────
  function togglePinEditMode(force){
    pinEditMode = typeof force === 'boolean' ? force : !pinEditMode;
    const minimap = document.getElementById('minimap');
    const btn = document.getElementById('my-loc-btn');
    if(minimap) minimap.style.cursor = pinEditMode ? 'crosshair' : '';
    if(btn) btn.classList.toggle('active', pinEditMode);
  }

  function placePin(lat, lon){
    pinLat = lat;
    pinLon = lon;
    if(pinMarker){
      pinMarker.setLatLng([pinLat, pinLon]);
      pinMarker.setOpacity(1);
    }
    updatePinLine();
    updatePinDistance();
    // 座標顯示
    const el1 = document.getElementById('pin-lat');
    const el2 = document.getElementById('pin-lon');
    if(el1) el1.textContent = pinLat.toFixed(6) + '°';
    if(el2) el2.textContent = pinLon.toFixed(6) + '°';
    const pinInfo = document.getElementById('map-pin-info');
    if(pinInfo) pinInfo.style.display = 'inline-flex';
    savePinToStorage();
  }

  function removePin(){
    pinLat = null; pinLon = null;
    if(pinMarker) pinMarker.setOpacity(0);
    if(pinLine) pinLine.setLatLngs([]);
    const distWrap = document.getElementById('pin-dist-wrap');
    if(distWrap) distWrap.style.display = 'none';
    const el1 = document.getElementById('pin-lat');
    const el2 = document.getElementById('pin-lon');
    if(el1) el1.textContent = '--°';
    if(el2) el2.textContent = '--°';
    const pinInfo = document.getElementById('map-pin-info');
    if(pinInfo) pinInfo.style.display = 'none';
    try { localStorage.removeItem('pinLoc'); } catch(e){}
  }

  function savePinToStorage(){
    if(pinLat === null) return;
    try { localStorage.setItem('pinLoc', JSON.stringify({lat:pinLat, lon:pinLon})); } catch(e){}
  }

  function loadPinFromStorage(){
    try {
      const s = localStorage.getItem('pinLoc');
      if(s){
        const o = JSON.parse(s);
        if(typeof o.lat === 'number' && typeof o.lon === 'number'){
          placePin(o.lat, o.lon);
        }
      }
    } catch(e){}
  }

  // ── GPS 我的位置→船 連線 & 距離 ───────────────────────────────────────
  function updateMyLocLine(){
    if(!myLocLine || myLat === null) return;
    const vll = vesselMarker ? vesselMarker.getLatLng() : null;
    if(!vll || (vll.lat === 23.5 && vll.lng === 120.0 && trackCoords.length === 0)){
      myLocLine.setLatLngs([]);
      return;
    }
    myLocLine.setLatLngs([[myLat, myLon], [vll.lat, vll.lng]]);
  }

  function updateGpsDistance(){
    const row = document.getElementById('gps-dist-row');
    const val = document.getElementById('gps-dist-val');
    if(!row || !val) return;
    if(myLat === null || !vesselMarker || trackCoords.length === 0){
      row.style.display = 'none'; return;
    }
    const vll = vesselMarker.getLatLng();
    const d = map.distance([myLat, myLon], [vll.lat, vll.lng]);
    row.style.display = 'inline';
    val.textContent = d < 1000 ? ('↔ ' + d.toFixed(0) + ' m') : ('↔ ' + (d/1000).toFixed(2) + ' km');
  }

  // ── 圖釘→船 連線 & 距離 ──────────────────────────────────────────────
  function updatePinLine(){
    if(!pinLine || pinLat === null) return;
    const vll = vesselMarker ? vesselMarker.getLatLng() : null;
    if(!vll || (vll.lat === 23.5 && vll.lng === 120.0 && trackCoords.length === 0)){
      pinLine.setLatLngs([]);
      return;
    }
    pinLine.setLatLngs([[pinLat, pinLon], [vll.lat, vll.lng]]);
  }

  function updatePinDistance(){
    const wrap = document.getElementById('pin-dist-wrap');
    const val = document.getElementById('pin-dist-val');
    if(!wrap || !val) return;
    if(pinLat === null || !vesselMarker || trackCoords.length === 0){
      wrap.style.display = 'none'; return;
    }
    const vll = vesselMarker.getLatLng();
    const d = map.distance([pinLat, pinLon], [vll.lat, vll.lng]);
    wrap.style.display = 'inline';
    val.textContent = '↔ ' + (d < 1000 ? d.toFixed(0) + ' m' : (d/1000).toFixed(2) + ' km');
  }

  // ── DOM 快取（一次查詢，永久參照）─────────────────────────────────────────
  let _el = null;
  function el(){
    if(_el) return _el;
    _el = {
      hud:        document.getElementById('tele-hud'),
      dot:        document.getElementById('tele-dot'),
      connTxt:    document.getElementById('tele-conn-txt'),
      hdg:        document.getElementById('tele-hdg'),
      needle:     document.getElementById('compass-needle'),
      sogNum:     document.getElementById('tele-sog'),
      sogArc:     document.getElementById('sog-arc'),
      sogNeedle:  document.getElementById('sog-needle'),
      sogGlow:    document.getElementById('sog-needle-glow'),
      thrArc:     document.getElementById('thr-arc'),
      thrNeedle:  document.getElementById('thr-needle'),
      thrGlow:    document.getElementById('thr-needle-glow'),
      lrpm:       document.getElementById('tele-lrpm'),
      rrpm:       document.getElementById('tele-rrpm'),
      barL:       document.getElementById('rpm-bar-l'),
      barR:       document.getElementById('rpm-bar-r'),
      lgear:      document.getElementById('tele-lgear'),
      rgear:      document.getElementById('tele-rgear'),
      rudder:     document.getElementById('rudder-act-num'),
      rudderNeedle:   document.getElementById('rudder-needle'),
      rudderArcL:     document.getElementById('rudder-arc-l'),
      rudderArcR:     document.getElementById('rudder-arc-r'),
      rudderCmdNum:   document.getElementById('rudder-cmd-num'),
      rudderNeedleCmd:document.getElementById('rudder-needle-cmd'),
      rudderArcCmdL:  document.getElementById('rudder-arc-cmd-l'),
      rudderArcCmdR:  document.getElementById('rudder-arc-cmd-r'),
      leverFillL: document.getElementById('lever-fill-l'),
      leverValL:  document.getElementById('lever-val-l'),
      leverFillR: document.getElementById('lever-fill-r'),
      leverValR:  document.getElementById('lever-val-r'),
      cog:        document.getElementById('tele-cog'),
      cogNeedle:  document.getElementById('cog-needle'),
      roll:       document.getElementById('tele-roll'),
      ahiHorizon: document.getElementById('ahi-horizon'),
      ahiRollPtr: document.getElementById('ahi-roll-ptr'),
      pitch:      document.getElementById('tele-pitch'),
      throttle:   document.getElementById('tele-throttle'),
      lat:        document.getElementById('tele-lat'),
      lon:        document.getElementById('tele-lon'),
      apBadge:    document.getElementById('tele-ap-badge'),
      ctrlStatus: document.getElementById('tele-ctrl-status'),
      neutralLed: document.getElementById('tele-neutral-led'),
      activeLed:  document.getElementById('tele-active-led'),
    };
    return _el;
  }

  // ── rAF 節流：WebSocket 高頻資料只在每個畫面幀更新一次 ──────────────────
  let _pendingControl = null;
  let _pendingGps     = null;
  let _rafId          = 0;

  function scheduleRender(){
    if(_rafId) return;                // 已排程就不再排
    _rafId = requestAnimationFrame(()=>{
      _rafId = 0;
      if(_pendingControl){ updateControl(_pendingControl); _pendingControl = null; }
      if(_pendingGps)    { updateGps(_pendingGps);         _pendingGps     = null; }
    });
  }

  function setLed(e, on){ if(e){ e.className='tele-led '+(on?'on':'off'); } }

  function setGear(e, gear){
    if(!e) return;
    e.textContent = gear;
    e.className = 'gear-badge ' + (gear || 'N');
  }

  let _hudAllowed = true;  // 由 app.js setView 控制

  function showHud(show){
    _hudAllowed = show;
    const h = el().hud;
    if(h) h.style.display = show ? 'block' : 'none';
  }

  /** 內部用：只在 _hudAllowed 時才顯示 */
  function showHudIfAllowed(){
    if(!_hudAllowed) return;
    const h = el().hud;
    if(h) h.style.display = 'block';
  }

  /** 控制 minimap 顯示/隱藏（由 app.js setView 呼叫） */
  function showMap(show){
    const wrap = document.getElementById('minimap-wrap');
    if(wrap) wrap.classList.toggle('hidden', !show);
  }

  /** 重設所有 HUD 元素到預設值（切換船隻時呼叫） */
  function resetHud(){
    // 只隱藏顯示，不改變 _hudAllowed（保留 overview 時的允許狀態）
    const h = el().hud;
    if(h) h.style.display = 'none';
    hasData = false;
    _el = null;  // 強制下次重新快取（以防 DOM 重建）
    _prev = {};  // 清除渲染值快取
    _accHdg = 0; _accCog = 0;  // 重設累積角度
    const e = el();
    if(e.hdg) e.hdg.textContent = '---°';
    if(e.needle) e.needle.style.transform = 'rotate(0deg)';
    if(e.sogNum) e.sogNum.textContent = '0.00';
    if(e.sogArc) e.sogArc.style.strokeDasharray = '0 600';
    if(e.lrpm) e.lrpm.textContent = '0';
    if(e.rrpm) e.rrpm.textContent = '0';
    if(e.barL) e.barL.style.width = '0%';
    if(e.barR) e.barR.style.width = '0%';
    if(e.rudder) e.rudder.textContent = '+0.0°';
    if(e.rudderCmdNum) e.rudderCmdNum.textContent = '+0.0°';
    if(e.lat) e.lat.textContent = '--.------°';
    if(e.lon) e.lon.textContent = '---.------°';
    if(e.cog) e.cog.textContent = '---°';
    if(e.cogNeedle) e.cogNeedle.style.transform = 'rotate(0deg)';
    if(e.roll) e.roll.textContent = '-.-°';
    if(e.pitch) e.pitch.textContent = '-.-°';
    if(e.ahiHorizon) e.ahiHorizon.setAttribute('transform', 'rotate(0,60,60) translate(0,0)');
    if(e.ahiRollPtr) e.ahiRollPtr.setAttribute('transform', 'rotate(0,60,60)');
    clearTrack();
    // 清除連線 & 距離（GPS 位置 & 圖釘保留，只清連線）
    if(myLocLine) myLocLine.setLatLngs([]);
    if(pinLine) pinLine.setLatLngs([]);
    const gpsDistRow = document.getElementById('gps-dist-row');
    if(gpsDistRow) gpsDistRow.style.display = 'none';
    const pinDistWrap = document.getElementById('pin-dist-wrap');
    if(pinDistWrap) pinDistWrap.style.display = 'none';
  }

  // ── 上次渲染值快取（跳過重複 DOM 寫入）──────────────────────────────────
  let _prev = {};
  // 累積 heading/cog 角度（避免 360→0 跳動，讓 CSS transition 走最短路徑）
  let _accHdg = 0, _accCog = 0;

  /** 將角度差歸一到 -180 ~ +180 */
  function shortAngle(from, to){
    let d = ((to - from) % 360 + 540) % 360 - 180;
    return d;
  }

  function updateControl(d){
    showHudIfAllowed();
    const e = el();
    const p = _prev;

    // ── Heading（最短路徑累積角度）──
    const hdgTxt = d.heading.toFixed(1) + '°';
    if(p.hdgTxt !== hdgTxt && e.hdg){ e.hdg.textContent = hdgTxt; p.hdgTxt = hdgTxt; }
    _accHdg += shortAngle(_accHdg, d.heading);
    if(e.needle) e.needle.style.transform = `rotate(${_accHdg}deg)`;

    // ── SOG ──
    const SOG_MAX = 55;
    const SOG_ARC_TOTAL = 279.3;
    const sogV = Math.max(0, Math.min(SOG_MAX, d.sog));
    const sogFrac = sogV / SOG_MAX;
    const sogNeedleDeg = -100 + sogFrac * 200;
    const sogArcLen = sogFrac * SOG_ARC_TOTAL;
    const sogTxt = d.sog.toFixed(2);
    if(p.sogTxt !== sogTxt && e.sogNum){ e.sogNum.textContent = sogTxt; p.sogTxt = sogTxt; }
    if(e.sogArc) e.sogArc.style.strokeDasharray = sogArcLen + ' 600';
    if(e.sogNeedle) e.sogNeedle.style.transform = `rotate(${sogNeedleDeg}deg)`;
    if(e.sogGlow)   e.sogGlow.style.transform   = `rotate(${sogNeedleDeg}deg)`;

    if(p.lrpm !== d.left_rpm){
      if(e.lrpm) e.lrpm.textContent = d.left_rpm;
      if(e.barL) e.barL.style.width = Math.min(100, Math.abs(d.left_rpm) / MAX_RPM * 100) + '%';
      p.lrpm = d.left_rpm;
    }
    if(p.lgear !== d.left_gear){ setGear(e.lgear, d.left_gear); p.lgear = d.left_gear; }
    if(p.rrpm !== d.right_rpm){
      if(e.rrpm) e.rrpm.textContent = d.right_rpm;
      if(e.barR) e.barR.style.width = Math.min(100, Math.abs(d.right_rpm) / MAX_RPM * 100) + '%';
      p.rrpm = d.right_rpm;
    }
    if(p.rgear !== d.right_gear){ setGear(e.rgear, d.right_gear); p.rgear = d.right_gear; }

    const RUDDER_MAX = 40;
    const ARC_HALF   = 86.0;

    // ── CMD 指令舵角 (steering) ──
    const steer = d.steering ?? 0;
    const clampedCmd = Math.max(-RUDDER_MAX, Math.min(RUDDER_MAX, steer));
    const fracCmd = clampedCmd / RUDDER_MAX;
    const degCmd = fracCmd * 105;
    if(e.rudderCmdNum) e.rudderCmdNum.textContent = (clampedCmd >= 0 ? '+' : '') + clampedCmd.toFixed(1) + '°';
    if(e.rudderNeedleCmd) e.rudderNeedleCmd.style.transform = `rotate(${degCmd}deg)`;
    if(e.rudderArcCmdL){
      if(clampedCmd < 0){
        const len = Math.abs(fracCmd) * ARC_HALF;
        e.rudderArcCmdL.setAttribute('stroke-dasharray', len + ' 500');
        e.rudderArcCmdL.setAttribute('stroke-dashoffset', -ARC_HALF + len);
      } else { e.rudderArcCmdL.setAttribute('stroke-dasharray', '0 500'); }
    }
    if(e.rudderArcCmdR){
      if(clampedCmd > 0){
        const len = fracCmd * ARC_HALF;
        e.rudderArcCmdR.setAttribute('stroke-dasharray', len + ' 500');
        e.rudderArcCmdR.setAttribute('stroke-dashoffset', -ARC_HALF);
      } else { e.rudderArcCmdR.setAttribute('stroke-dasharray', '0 500'); }
    }

    // ── ACT 實際舵角 (rudder) ──
    const rud = d.rudder ?? 0;
    const clampedRud = Math.max(-RUDDER_MAX, Math.min(RUDDER_MAX, rud));
    const frac = clampedRud / RUDDER_MAX;
    const degRot = frac * 105;
    if(e.rudder)    e.rudder.textContent = (clampedRud >= 0 ? '+' : '') + clampedRud.toFixed(1) + '°';
    if(e.rudderNeedle) e.rudderNeedle.style.transform = `rotate(${degRot}deg)`;
    if(e.rudderArcL){
      if(clampedRud < 0){
        const len = Math.abs(frac) * ARC_HALF;
        e.rudderArcL.setAttribute('stroke-dasharray', len + ' 500');
        e.rudderArcL.setAttribute('stroke-dashoffset', -ARC_HALF + len);
      } else { e.rudderArcL.setAttribute('stroke-dasharray', '0 500'); }
    }
    if(e.rudderArcR){
      if(clampedRud > 0){
        const len = frac * ARC_HALF;
        e.rudderArcR.setAttribute('stroke-dasharray', len + ' 500');
        e.rudderArcR.setAttribute('stroke-dashoffset', -ARC_HALF);
      } else { e.rudderArcR.setAttribute('stroke-dasharray', '0 500'); }
    }

    const LEVER_MAX = 100;
    function updateLeverH(fillEl, valEl, raw, colorFwd, colorRev){
      if(!fillEl && !valEl) return;
      const v = Math.max(-LEVER_MAX, Math.min(LEVER_MAX, raw));
      const pct = v / LEVER_MAX;
      if(fillEl){
        const halfW = 50;
        if(pct > 0){
          fillEl.style.left  = '50%';
          fillEl.style.width = (pct * halfW) + '%';
          fillEl.style.background = colorFwd;
        } else if(pct < 0){
          const w = Math.abs(pct) * halfW;
          fillEl.style.left  = (50 - w) + '%';
          fillEl.style.width = w + '%';
          fillEl.style.background = colorRev;
        } else {
          fillEl.style.left  = '50%';
          fillEl.style.width = '0';
        }
        fillEl.style.top    = '0';
        fillEl.style.bottom = '0';
        fillEl.style.height = '100%';
      }
      if(valEl){
        valEl.textContent = (v >= 0 ? '+' : '') + v;
        valEl.style.color = v > 0 ? colorFwd : v < 0 ? colorRev : '#eef2f7';
      }
    }
    updateLeverH(e.leverFillL, e.leverValL, d.left_lever  || 0, '#00e676', '#ff3d57');
    updateLeverH(e.leverFillR, e.leverValR, d.right_lever || 0, '#00e676', '#ff3d57');

    // ── COG（最短路徑累積角度）──
    const cogTxt = d.cog.toFixed(1) + '°';
    if(p.cogTxt !== cogTxt && e.cog){ e.cog.textContent = cogTxt; p.cogTxt = cogTxt; }
    _accCog += shortAngle(_accCog, d.cog);
    if(e.cogNeedle) e.cogNeedle.style.transform = `rotate(${_accCog}deg)`;

    // ── AHI 人工水平儀（合併 Roll + Pitch）──
    const rollClamped = Math.max(-35, Math.min(35, d.roll));
    const pitchClamped = Math.max(-20, Math.min(20, d.pitch));
    // pitch → 每度 1.8px 垂直位移 (±20° → ±36px)
    const pitchPx = pitchClamped * 1.8;
    // horizon 群組同時 rotate(roll) + translateY(pitch)
    if(e.ahiHorizon) e.ahiHorizon.setAttribute('transform',
      `rotate(${-rollClamped.toFixed(1)},60,60) translate(0,${pitchPx.toFixed(1)})`);
    // roll 三角指標只旋轉
    if(e.ahiRollPtr) e.ahiRollPtr.setAttribute('transform',
      `rotate(${-rollClamped.toFixed(1)},60,60)`);
    if(e.roll){
      e.roll.textContent = (d.roll >= 0 ? '+' : '') + d.roll.toFixed(1) + '°';
      e.roll.style.color = Math.abs(d.roll) > 15 ? '#ff3d57' : Math.abs(d.roll) > 7 ? '#f0a500' : '#eef2f7';
    }
    if(e.pitch){
      e.pitch.textContent = (d.pitch >= 0 ? '+' : '') + d.pitch.toFixed(1) + '°';
      e.pitch.style.color = Math.abs(d.pitch) > 10 ? '#ff3d57' : Math.abs(d.pitch) > 5 ? '#f0a500' : '#eef2f7';
    }

    const THR_ARC_TOTAL = 209.4;
    const thrV = Math.max(0, Math.min(100, d.throttle));
    const thrFrac = thrV / 100;
    const thrNeedleDeg = -100 + thrFrac * 200;
    const thrArcLen = thrFrac * THR_ARC_TOTAL;
    if(e.throttle) e.throttle.textContent = thrV + '%';
    if(e.thrArc) e.thrArc.style.strokeDasharray = thrArcLen + ' 600';
    if(e.thrNeedle) e.thrNeedle.style.transform = `rotate(${thrNeedleDeg}deg)`;
    if(e.thrGlow)   e.thrGlow.style.transform   = `rotate(${thrNeedleDeg}deg)`;

    if(e.apBadge){
      const isAuto = d.autopilot_mode !== 0;
      e.apBadge.textContent = isAuto ? 'AUTO' : 'MANUAL';
      e.apBadge.className = 'tele-ap-badge' + (isAuto ? ' active' : '');
    }
    if(e.ctrlStatus) e.ctrlStatus.textContent = d.control_status || '---';
    setLed(e.neutralLed, d.neutral_led);
    setLed(e.activeLed, d.active_led);
  }

  function updateGps(d){
    const e = el();
    if(e.lat) e.lat.textContent = d.lat.toFixed(6) + '°';
    if(e.lon) e.lon.textContent = d.lon.toFixed(6) + '°';
    updateMapPosition(d.lat, d.lon);
  }

  function setConnState(connected, vesselId){
    const e = el();
    if(e.dot){
      e.dot.style.background = connected ? '#00e676' : '#ff3d57';
      e.dot.style.boxShadow  = connected ? '0 0 6px #00e676' : 'none';
    }
    if(e.connTxt){
      if(connected){
        e.connTxt.textContent = 'TELEMETRY · ' + (vesselId || '').toUpperCase();
      } else {
        e.connTxt.textContent = 'TELEMETRY';
      }
    }
  }

  function disconnect(){
    clearTimeout(retryTimer);
    if(ws){
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
  }

  function connect(vesselId){
    disconnect();
    if(!vesselId) { setConnState(false); return; }
    currentVesselId = vesselId;
    ws = new WebSocket('ws://' + location.hostname + ':8080/ws/telemetry/' + vesselId);
    ws.onopen = () => { setConnState(true, vesselId); };
    ws.onmessage = ({data}) => {
      try {
        const d = JSON.parse(data);
        if(d.type === 'control') _pendingControl = d;
        if(d.type === 'gps')     _pendingGps     = d;
        scheduleRender();
        if(!hasData){ hasData = true; showHudIfAllowed(); }
      } catch(e){ console.warn('[Telemetry] parse error', e); }
    };
    ws.onclose = () => {
      setConnState(false);
      // 只在仍然訂閱同一艘船時才重連
      if(currentVesselId === vesselId){
        retryTimer = setTimeout(()=>connect(vesselId), 3000);
      }
    };
    ws.onerror = () => ws.close();
  }

  /**
   * 切換遙測到指定船隻（由 app.selV 呼叫）
   * 1. 斷開舊 WebSocket
   * 2. 清空 HUD + 地圖軌跡
   * 3. 連線到新船隻的 WebSocket
   */
  function switchVessel(vesselId){
    if(currentVesselId === vesselId) return;
    resetHud();
    connect(vesselId);
  }

  // 等 DOM 完成後初始化地圖
  document.addEventListener('DOMContentLoaded', ()=>{
    initMap();
    // 不在這裡自動 connect，等 app.selV 觸發
  });
  if(document.readyState !== 'loading'){
    initMap();
  }

  // 暴露到全域供 app 呼叫
  window.teleHudShow = showHud;
  window.teleMapShow = showMap;
  window.teleSwitchVessel = switchVessel;
})();
