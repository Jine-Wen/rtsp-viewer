/* ── JetseaAI Fleet Monitor — 主應用程式 ─────────────────────────────────── */

const RL={main:'主鏡頭',bridge:'駕駛艙',deck:'甲板',engine:'機艙'};
const RI={main:'🎥',bridge:'🎮',deck:'📡',engine:'⚙'};
const app=(()=>{
  let st=[],vessels=[],hls={},vessel='',mId=null,pId=null,view='overview';
  function clk(){const n=new Date();document.getElementById('clk').textContent=n.toLocaleTimeString('zh-TW');document.getElementById('clkd').textContent=n.toLocaleDateString('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'});}
  setInterval(clk,1000);clk();
  setInterval(()=>{const e=document.getElementById('hud-br');if(e)e.textContent=new Date().toLocaleTimeString('zh-TW');},1000);
  const A={get:async p=>{const r=await fetch(p);if(!r.ok)throw Error(r.status);return r.json()},post:async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):null});if(!r.ok)throw Error(r.status);return r.json()},put:async(p,b)=>{const r=await fetch(p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw Error(r.status);return r.json()},del:async p=>{const r=await fetch(p,{method:'DELETE'});if(!r.ok)throw Error(r.status);return r.json()}};
  function toast(m,t='info'){const c=document.getElementById('toasts'),e=document.createElement('div');e.className='toast '+t;const ic={ok:'✓',err:'✕',warn:'⚠',info:'·'};const cl={ok:'var(--green)',err:'var(--red)',warn:'var(--amber)',info:'var(--blue)'};e.innerHTML='<span style="color:'+( cl[t]||cl.info)+';font-weight:700">'+(ic[t]||'·')+'</span>'+m;c.appendChild(e);setTimeout(()=>e.remove(),3000);}

  // ── 船隻管理 ──────────────────────────────────────────────────────────────
  function vd(id){return vessels.find(v=>v.id===id)||{name:id,icon:'🚢',meta:''};}

  function renderFleetPills(){
    const fp=document.getElementById('fleet-pills');
    let h='';
    vessels.forEach(v=>{
      const isActive=v.id===vessel;
      h+=`<div class="fpill${isActive?' active':''}" data-v="${v.id}" onclick="app.selV('${v.id}')">
        <div class="pdot" id="pd-${v.id}"></div>${esc(v.name)}
        <span class="vpill-edit" onclick="event.stopPropagation();app.openEditV('${v.id}')" title="編輯船隻">✎</span>
      </div>`;
    });
    h+=`<button class="vpill-add" onclick="app.openAddV()">＋</button>`;
    fp.innerHTML=h;
    // 同步更新攝影機 modal 的船隻 select
    const iv=document.getElementById('iv');
    if(iv){
      const cur=iv.value;
      iv.innerHTML=vessels.map(v=>`<option value="${v.id}">${esc(v.name)}</option>`).join('');
      if(vessels.find(v=>v.id===cur))iv.value=cur;
    }
  }

  async function loadVessels(){
    try{
      vessels=await A.get('/api/vessels');
      renderFleetPills();
      updP();
      // 初次載入時自動選第一艘
      if(!vessel&&vessels.length){selV(vessels[0].id);}
    }catch{toast('無法載入船隻清單','err');}
  }

  function openAddV(){
    document.getElementById('vmtitle').textContent='新增船隻';
    document.getElementById('veid').value='';
    document.getElementById('viid').value='';
    document.getElementById('viid').removeAttribute('readonly');
    document.getElementById('viid-hint').style.display='';
    document.getElementById('viname').value='';
    document.getElementById('viicon').value='🚢';
    document.getElementById('vicon-preview').textContent='🚢';
    document.querySelectorAll('.icon-opt').forEach(o=>o.classList.toggle('sel',o.dataset.ic==='🚢'));
    document.getElementById('vimeta').value='';
    document.getElementById('vtele-ip').value='';
    document.getElementById('vtele-tcp').value='10000';
    document.getElementById('vtele-udp').value='0';
    document.getElementById('vtele-status').textContent='未設定';
    document.getElementById('vtele-status').style.cssText='font-size:7px;padding:2px 6px;border-radius:2px;border:1px solid var(--b-hull);color:var(--t-dim)';
    document.getElementById('vdelbtn').style.display='none';
    document.getElementById('vmodal').classList.add('open');
    setTimeout(()=>document.getElementById('viname').focus(),100);
  }

  function openEditV(id){
    const v=vd(id);
    document.getElementById('vmtitle').textContent='編輯船隻';
    document.getElementById('veid').value=id;
    document.getElementById('viid').value=id;
    document.getElementById('viid').setAttribute('readonly','readonly');
    document.getElementById('viid-hint').style.display='none';
    document.getElementById('viname').value=v.name;
    document.getElementById('viicon').value=v.icon||'🚢';
    document.getElementById('vicon-preview').textContent=v.icon||'🚢';
    document.querySelectorAll('.icon-opt').forEach(o=>o.classList.toggle('sel',o.dataset.ic===(v.icon||'🚢')));
    document.getElementById('vimeta').value=v.meta||'';
    document.getElementById('vtele-ip').value=v.telemetry_ip||'';
    document.getElementById('vtele-tcp').value=v.telemetry_tcp_port||10000;
    document.getElementById('vtele-udp').value=v.telemetry_udp_port||0;
    // 顯示遙測連線狀態
    const statusEl=document.getElementById('vtele-status');
    if(v.telemetry_ip){
      statusEl.textContent='已設定';
      statusEl.style.cssText='font-size:7px;padding:2px 6px;border-radius:2px;border:1px solid rgba(0,230,118,.3);color:#00e676;background:rgba(0,230,118,.08)';
    } else {
      statusEl.textContent='未設定';
      statusEl.style.cssText='font-size:7px;padding:2px 6px;border-radius:2px;border:1px solid var(--b-hull);color:var(--t-dim)';
    }
    document.getElementById('vdelbtn').style.display='';
    document.getElementById('vmodal').classList.add('open');
  }

  function closeVModal(){document.getElementById('vmodal').classList.remove('open');}

  async function saveVessel(){
    const eid=document.getElementById('veid').value;
    const id=(eid||document.getElementById('viid').value.trim().toLowerCase().replace(/[^a-z0-9]/g,''));
    const name=document.getElementById('viname').value.trim();
    const icon=document.getElementById('viicon').value||'🚢';
    const meta=document.getElementById('vimeta').value.trim();
    const teleIp=document.getElementById('vtele-ip').value.trim();
    const teleTcp=parseInt(document.getElementById('vtele-tcp').value)||10000;
    const teleUdp=parseInt(document.getElementById('vtele-udp').value)||0;
    if(!id){toast('請填寫船隻 ID','warn');return;}
    if(!name){toast('請填寫船隻名稱','warn');return;}
    const body={id,name,icon,meta,telemetry_ip:teleIp,telemetry_tcp_port:teleTcp,telemetry_udp_port:teleUdp};
    try{
      if(eid){await A.put('/api/vessels/'+eid,body);}
      else{await A.post('/api/vessels',body);}
      // 同步更新遙測連線
      try{
        await A.post('/api/telemetry/config/'+id,{telemetry_ip:teleIp,telemetry_tcp_port:teleTcp,telemetry_udp_port:teleUdp});
        if(teleIp) toast('遙測連線已啟動','ok');
      }catch(e){ console.warn('Telemetry config update:', e); }
      toast(eid?'船隻已更新':'船隻已新增','ok');
      closeVModal();
      await loadVessels();
      if(!eid)selV(id);
    }catch(e){toast('儲存失敗：'+e.message,'err');}
  }

  async function delVessel(){
    const id=document.getElementById('veid').value;
    const v=vd(id);
    if(!confirm(`確定刪除「${v.name}」？\n此船隻下的攝影機不會被刪除，但將失去所屬船隻顯示。`))return;
    try{
      await A.del('/api/vessels/'+id);
      toast('船隻已刪除','warn');
      closeVModal();
      await loadVessels();
      if(vessel===id&&vessels.length){selV(vessels[0].id);}
    }catch(e){toast('刪除失敗：'+e.message,'err');}
  }

  // ── 串流 ──────────────────────────────────────────────────────────────────
  async function load(){try{st=await A.get('/api/streams');document.getElementById('apierr').style.display='none';renderSb();updH();updP();if(view==='grid')renderGrid();if(mId){const s=st.find(x=>x.id===mId);if(s)syncM(s);}if(view==='overview'){
    // PiP 自動連線：若 pId 已設但畫面還沒播（offline→online），重新 bind
    if(pId){const s=st.find(x=>x.id===pId);if(s)bindPip(s.id);}
    // 若 pId 還未設定但 bridge 鏡頭已上線，自動啟動 PiP
    else{const bc=vCams().find(s=>s.role==='bridge'&&(s.status==='online'||s.status==='live'));if(bc){document.getElementById('pip').style.display='block';bindPip(bc.id);}}
  }}catch{document.getElementById('apierr').style.display='block';}}
  function updH(){document.getElementById('h-live').textContent=st.filter(s=>s.status==='live'||s.status==='online').length;document.getElementById('h-total').textContent=st.length;}
  function updP(){
    vessels.forEach(v=>{
      const d=document.getElementById('pd-'+v.id);
      if(!d)return;
      const a=st.filter(s=>s.group===v.id).some(s=>s.status==='live'||s.status==='online');
      d.className='pdot'+(a?' live':'');
    });
  }
  function selV(v){vessel=v;
    renderFleetPills();
    const vdata=vd(v);
    document.getElementById('sb-ic').textContent=vdata.icon||'🚢';
    document.getElementById('sb-nm').textContent=vdata.name||v;
    document.getElementById('sb-mt').textContent=vdata.meta||'';
    document.getElementById('m-vn').textContent=vdata.name||v;
    document.getElementById('hud-vn').textContent=vdata.name||v;
    renderSb();
    // 切換遙測 WebSocket 到新船隻
    if(typeof window.teleSwitchVessel==='function') window.teleSwitchVessel(v);
    // 切換船隻時強制銷毀舊的主畫面與 PiP 連線，確保重新載入
    if(mId){destroyH('m__'+mId);}
    if(pId){destroyH('p__'+pId);}
    mId=null;pId=null;
    const vc=st.filter(s=>s.group===v);const mc=vc.find(s=>s.role==='main')||vc[0];if(mc)selM(mc.id);else{mId=null;resetM();}
    // PiP：只在 overview 且有 bridge 鏡頭時才顯示
    if(view==='overview'){
      const bc=vc.find(s=>s.role==='bridge');
      if(bc){document.getElementById('pip').style.display='block';bindPip(bc.id);}
      else{document.getElementById('pip').style.display='none';clearPip();}
    }
    if(view==='grid')renderGrid();}
  function vCams(){return st.filter(s=>s.group===vessel);}
  function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
  function renderSb(){const list=document.getElementById('clist'),vc=vCams();if(!vc.length){list.innerHTML='<div style="padding:28px 14px;text-align:center;color:var(--t-dim);font-family:JetBrains Mono,monospace;font-size:10px;line-height:2"><div style="font-size:26px;margin-bottom:8px">📡</div>此船隻尚無攝影機</div>';return;}const ord={main:0,bridge:1,deck:2,engine:3};const s2=[...vc].sort((a,b)=>(ord[a.role]??9)-(ord[b.role]??9));let h='',lr=null;s2.forEach(s=>{if(s.role!==lr){h+='<div class="slbl">'+(RL[s.role]||s.role)+'</div>';lr=s.role;}const cls=s.id===mId?'active':s.id===pId?'pip-a':'';const isLive=s.status==='live'||s.status==='online';h+=`<div class="ci ${cls}" id="ci-${s.id}" onclick="app.selM('${s.id}')"><div class="cthumb">${RI[s.role]||'🎥'}<div class="cdot ${isLive?'live':s.status}" id="cd-${s.id}"></div></div><div class="ci-info"><div class="ci-name">${esc(s.name)}</div><div class="ci-role"><span class="rb ${s.role||'main'}">${(RL[s.role]||s.role).toUpperCase()}</span>${isLive?'<span style="color:var(--green);font-size:7px">● LIVE</span>':''}</div></div><div class="cacts">${s.role==='bridge'?`<button class="ab pip" title="設為 PiP" onclick="event.stopPropagation();app.setPip('${s.id}')">⊡</button>`:''}${isLive?`<button class="ab" title="停止" onclick="event.stopPropagation();app.stopCam('${s.id}')">■</button>`:`<button class="ab" title="啟動" onclick="event.stopPropagation();app.startCam('${s.id}')">▶</button>`}<button class="ab" title="編輯" onclick="event.stopPropagation();app.openEdit('${s.id}')">✎</button><button class="ab del" title="刪除" onclick="event.stopPropagation();app.delCam('${s.id}')">✕</button></div></div>`;});list.innerHTML=h;}
  function selM(id){
    // 若切換到不同鏡頭，先銷毀舊主畫面連線
    if(mId && mId!==id){destroyH('m__'+mId);}
    mId=id;const s=st.find(x=>x.id===id);if(!s)return;document.getElementById('m-cn').textContent=' · '+s.name;document.getElementById('m-url').textContent=s.rtsp_url;document.getElementById('hud-cn').textContent=s.name;syncM(s);renderSb();}
  function syncM(s){const b=document.getElementById('m-badge'),lb={live:'LIVE',online:'LIVE',stopped:'OFFLINE',offline:'OFFLINE',starting:'STARTING',error:'ERROR'};b.className='mbadge '+(s.status==='online'?'live':s.status);b.textContent=lb[s.status]||s.status.toUpperCase();document.getElementById('hud-rec').style.display=(s.status==='live'||s.status==='online')?'flex':'none';const o=document.getElementById('movl');if((s.status==='live'||s.status==='online')&&s.hls_url){o.classList.add('hidden');loadWebRTC('mvideo',s.id,'movl','m__'+s.id,s.hls_url);}else if(s.status==='starting'){
    // starting 狀態：顯示啟動中動畫，並嘗試 WebRTC 連線。
    // WebRTC 連線動作本身會觸發 MediaMTX runOnDemand 啟動 FFmpeg。
    // 若連線成功 loadWebRTC 會自動 hide overlay；若連線失敗則 overlay 繼續顯示等待下次輪詢重試。
    if(!hls['m__'+s.id+'_pc']){o.classList.remove('hidden');o.innerHTML='<div class="ol-spin"></div><div class="ol-msg">串流啟動中…</div>';loadWebRTC('mvideo',s.id,'movl','m__'+s.id,s.hls_url);}
  }else{o.classList.remove('hidden');o.innerHTML='<div class="ol-icon">🚢</div><div class="ol-msg">'+esc(s.name)+'</div><div class="ol-sub">點擊「啟動」開始</div>';destroyH('m__'+s.id);}}
  function resetM(){document.getElementById('m-cn').textContent='';document.getElementById('m-url').textContent='';const o=document.getElementById('movl');o.classList.remove('hidden');o.innerHTML='<div class="ol-icon">🚢</div><div class="ol-msg">選擇攝影機</div><div class="ol-sub">從左側選擇鏡頭</div>';}
  function bindPip(id){
    pId=id;
    const s=st.find(x=>x.id===id);if(!s){clearPip();return;}
    document.getElementById('pip-mark').textContent=s.name;
    const lv=document.getElementById('pip-lv'),po=document.getElementById('pip-ovl');
    if((s.status==='live'||s.status==='online')&&s.hls_url){
      po.classList.add('hidden');lv.style.display='flex';
      loadWebRTC('pip-vid',s.id,'pip-ovl','p__'+id,s.hls_url);
    }else if(s.status==='starting'){
      // starting 時也嘗試連線（觸發 runOnDemand），若失敗就顯示等待文字
      lv.style.display='flex';
      if(!hls['p__'+id+'_pc']){po.classList.remove('hidden');po.innerHTML='<div class="pip-oi">🎮</div><div class="pip-om">連線中…</div>';loadWebRTC('pip-vid',s.id,'pip-ovl','p__'+id,s.hls_url);}
    }else{
      lv.style.display='none';po.classList.remove('hidden');
      po.innerHTML='<div class="pip-oi">🎮</div><div class="pip-om">'+(s.status==='stopped'||s.status==='offline'?'駕駛艙離線':'連線中…')+'</div>';
    }
  }
  function clearPip(){pId=null;document.getElementById('pip-lv').style.display='none';const po=document.getElementById('pip-ovl');po.classList.remove('hidden');po.innerHTML='<div class="pip-oi">🎮</div><div class="pip-om">無駕駛艙鏡頭</div>';}
  function setPip(id){
    if(view!=='overview'){toast('請切換至主畫面模式以使用 PiP','warn');return;}
    document.getElementById('pip').style.display='block';
    bindPip(id);toast('駕駛艙 PiP 已切換','info');}
  function loadHls(vid,url,oId,key){
    const video=document.getElementById(vid),ovl=document.getElementById(oId);
    if(!video)return;
    if(hls[key] && hls[key]._url===url) return;
    if(hls[key]){try{hls[key].destroy();}catch(_){} delete hls[key];}
    if(Hls.isSupported()){
      const h=new Hls({
        enableWorker:true,
        lowLatencyMode:false,
        liveSyncDurationCount:3,
        liveMaxLatencyDurationCount:5,
        maxBufferLength:15,
        maxBufferHole:0.5,
        nudgeMaxRetry:10,
        fragLoadingMaxRetry:4,
        manifestLoadingMaxRetry:3,
        startPosition:-1,
      });
      h._url=url;
      hls[key]=h;
      h.loadSource(url);
      h.attachMedia(video);
      h.on(Hls.Events.MANIFEST_PARSED,()=>{video.play().catch(()=>{});if(ovl)ovl.classList.add('hidden');});
      h.on(Hls.Events.ERROR,(_,d)=>{
        if(!d.fatal)return;
        if(d.type===Hls.ErrorTypes.NETWORK_ERROR){setTimeout(()=>{try{h.startLoad();}catch(_){}},1500);}
        else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){try{h.recoverMediaError();}catch(_){}}
        else{if(ovl)ovl.classList.remove('hidden');}
      });
    }else if(video.canPlayType('application/vnd.apple.mpegurl')){
      video.src=url;
      video.addEventListener('loadedmetadata',()=>{video.play().catch(()=>{});if(ovl)ovl.classList.add('hidden');},{once:true});
    }
  }

  // WHEP (WebRTC) 播放 — ice-lite 相容版本（等待 ICE gathering 完成後才送 offer）
  function loadWebRTC(vid,streamId,oId,key,fallbackUrl){
    const video=document.getElementById(vid),ovl=document.getElementById(oId);
    if(!video)return;
    // 若已有相同 streamId 的 WebRTC 連線在跑，不重建
    if(hls[key+'_pc'] && hls[key+'_pcId']===streamId) return;
    destroyH(key);

    const whepUrl=`http://localhost:8889/${streamId}/whep`;
    if(typeof RTCPeerConnection==='undefined'){loadHls(vid,fallbackUrl,oId,key);return;}

    const pc=new RTCPeerConnection({
      iceServers:[],          //  ice-lite 不需要 STUN
      bundlePolicy:'max-bundle',
      rtcpMuxPolicy:'require',
    });
    hls[key+'_pc']=pc;
    hls[key+'_pcId']=streamId;

    pc.addTransceiver('video',{direction:'recvonly'});
    pc.addTransceiver('audio',{direction:'recvonly'});

    pc.ontrack=e=>{
      if(e.streams && e.streams[0]){
        video.srcObject=e.streams[0];
        video.play().catch(()=>{});
        if(ovl)ovl.classList.add('hidden');
      }
    };

    // 連線斷開則 fallback 到 HLS
    pc.oniceconnectionstatechange=()=>{
      const s=pc.iceConnectionState;
      if(s==='failed'||s==='disconnected'||s==='closed'){
        destroyH(key);
        loadHls(vid,fallbackUrl,oId,key);
      }
    };

    pc.createOffer()
      .then(offer=>pc.setLocalDescription(offer))
      .then(()=>new Promise(resolve=>{
        // 等待 ICE gathering 完成後再送 offer（ice-lite 必須）
        if(pc.iceGatheringState==='complete'){resolve();return;}
        pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')resolve();};
        // 最多等 3 秒
        setTimeout(resolve,3000);
      }))
      .then(()=>{
        return fetch(whepUrl,{
          method:'POST',
          headers:{'Content-Type':'application/sdp'},
          body:pc.localDescription.sdp,
        });
      })
      .then(r=>{
        if(!r.ok)throw new Error('WHEP '+r.status);
        return r.text();
      })
      .then(sdp=>{
        return pc.setRemoteDescription({type:'answer',sdp});
      })
      .catch(err=>{
        console.warn('[WebRTC] 失敗，fallback HLS:',err);
        destroyH(key);
        loadHls(vid,fallbackUrl,oId,key);
      });
  }

  function destroyH(k){
    if(hls[k]){try{hls[k].destroy();}catch(_){} delete hls[k];}
    if(hls[k+'_pc']){try{hls[k+'_pc'].close();}catch(_){} delete hls[k+'_pc']; delete hls[k+'_pcId'];}
  }
  function renderGrid(){
    const gv=document.getElementById('grid-view'),vc=vCams(),n=vc.length;
    const c=n<=2?'g2':n===3?'g3':n<=4?'g4':'g6';
    if(!n){
      vCams().forEach(s=>destroyH('g__'+s.id));
      gv.className=c;gv.style.display='flex';
      gv.innerHTML='<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--t-dim);font-size:11px">此船隻尚無攝影機</div>';
      return;
    }
    const curIds=vc.map(s=>s.id).join(',');
    const rebuild=gv.dataset.ids!==curIds;
    if(rebuild){
      (gv.dataset.ids||'').split(',').filter(Boolean).forEach(id=>destroyH('g__'+id));
      gv.dataset.ids=curIds;
      gv.className=c;gv.style.display='grid';
      let h='';
      vc.forEach(s=>{
        const f=s.id===mId?' foc':'';
        const isLive=s.status==='live'||s.status==='online';
        h+=`<div class="gcell${f}" id="gcell-${s.id}" onclick="app.selM('${s.id}')"><video id="gv-${s.id}" muted autoplay playsinline></video><div class="gc-ovl${isLive?' hidden':''}" id="gco-${s.id}">${s.status==='starting'?'啟動中…':'OFFLINE'}</div><div class="gc-lbl"><span class="gc-nm">${esc(s.name)}</span>${isLive?'<div class="gc-lv"><div class="gc-ld"></div>LIVE</div>':''}</div></div>`;
      });
      gv.innerHTML=h;
    }else{
      vc.forEach(s=>{
        const isLive=s.status==='live'||s.status==='online';
        const cell=document.getElementById('gcell-'+s.id);
        if(cell){cell.className='gcell'+(s.id===mId?' foc':'');}
        const ovl=document.getElementById('gco-'+s.id);
        if(ovl){
          if(isLive){ovl.classList.add('hidden');}
          else{ovl.classList.remove('hidden');ovl.textContent=s.status==='starting'?'啟動中…':'OFFLINE';}
        }
      });
    }
    vc.forEach(s=>{
      const isLive=s.status==='live'||s.status==='online';
      if(isLive&&s.hls_url){
        const vid=document.getElementById('gv-'+s.id);
        if(vid&&!hls['g__'+s.id+'_pc']&&!hls['g__'+s.id]){
          loadWebRTC('gv-'+s.id,s.id,'gco-'+s.id,'g__'+s.id,s.hls_url);
        }
      }
    });
  }
  function setView(m){view=m;document.querySelectorAll('.vmbtn').forEach(b=>b.classList.toggle('active',b.dataset.vm===m));const mw=document.getElementById('mvwrap'),gv=document.getElementById('grid-view'),pip=document.getElementById('pip');const huds=document.querySelectorAll('.hud-tl,.hud-bl,.hud-br');if(m==='overview'){
      mw.style.display='flex';gv.style.display='none';huds.forEach(h=>h.style.display='');
      if(window.teleHudShow) window.teleHudShow(true);
      if(window.teleMapShow) window.teleMapShow(true);
      vCams().forEach(s=>destroyH('g__'+s.id));gv.dataset.ids='';
      const bc=vCams().find(s=>s.role==='bridge');
      if(bc){pip.style.display='block';bindPip(bc.id);}else{pip.style.display='none';clearPip();}
    }else if(m==='single'){
      mw.style.display='flex';gv.style.display='none';pip.style.display='none';huds.forEach(h=>h.style.display='');
      if(window.teleHudShow) window.teleHudShow(false);
      if(window.teleMapShow) window.teleMapShow(false);
      vCams().forEach(s=>destroyH('g__'+s.id));gv.dataset.ids='';
      if(pId){destroyH('p__'+pId);}pId=null;
    }else{
      mw.style.display='none';gv.style.display='grid';pip.style.display='none';huds.forEach(h=>h.style.display='none');
      if(window.teleHudShow) window.teleHudShow(false);
      if(window.teleMapShow) window.teleMapShow(false);
      if(pId){destroyH('p__'+pId);}pId=null;
      renderGrid();
    }
  }
  async function startCam(id){
    try{
      await A.post('/api/streams/'+id+'/start');
      toast('啟動中…','info');
      // 立刻嘗試建立 WebRTC 連線，這個動作會觸發 MediaMTX runOnDemand 啟動 FFmpeg
      const si=st.find(x=>x.id===id);
      if(si&&id===mId){destroyH('m__'+id);syncM({...si,status:'starting'});}
      let attempts=0;
      const poll=setInterval(async()=>{
        await load();
        const s=st.find(x=>x.id===id);
        if(s&&(s.status==='online'||s.status==='live')){
          clearInterval(poll);
          if(id===mId)syncM(s);
          if(id===pId&&view==='overview')bindPip(id);
          toast(s.name+' 已上線','ok');
        }
        if(++attempts>=20)clearInterval(poll); // 最多等 24 秒（20×1.2s）
      },1200);
    }catch{toast('啟動失敗','err');}
  }
  async function stopCam(id){try{await A.post('/api/streams/'+id+'/stop');destroyH('m__'+id);destroyH('p__'+id);toast('已停止','warn');await load();if(id===mId){const s=st.find(x=>x.id===id);if(s)syncM(s);}if(id===pId&&view==='overview')bindPip(id);}catch{toast('停止失敗','err');}}
  function startMain(){if(mId)startCam(mId);else toast('請先選擇鏡頭','warn');}
  function stopMain(){if(mId)stopCam(mId);}
  async function startV(){const vc=vCams();toast('啟動 '+vd(vessel).name+' 全部鏡頭…','info');for(const s of vc)if(s.status!=='live')await startCam(s.id).catch(()=>{});}
  async function stopV(){const vc=vCams().filter(s=>s.status==='live');for(const s of vc)await stopCam(s.id).catch(()=>{});toast(vd(vessel).name+' 全部停止','warn');}
  function openAdd(){document.getElementById('mtitle').textContent='新增攝影機';document.getElementById('eid').value='';document.getElementById('iname').value='';document.getElementById('iurl').value='';document.getElementById('iv').value=vessel;document.getElementById('irole').value='main';document.querySelectorAll('.ro').forEach(o=>o.classList.toggle('sel',o.dataset.r==='main'));document.getElementById('modal').classList.add('open');setTimeout(()=>document.getElementById('iname').focus(),100);}
  function openEdit(id){const s=st.find(x=>x.id===id);if(!s)return;document.getElementById('mtitle').textContent='編輯攝影機';document.getElementById('eid').value=id;document.getElementById('iname').value=s.name;document.getElementById('iurl').value=s.rtsp_url;document.getElementById('iv').value=s.group||vessel;document.getElementById('irole').value=s.role||'main';document.querySelectorAll('.ro').forEach(o=>o.classList.toggle('sel',o.dataset.r===(s.role||'main')));document.getElementById('modal').classList.add('open');}
  function closeModal(){document.getElementById('modal').classList.remove('open');}
  async function saveCam(){const eid=document.getElementById('eid').value,name=document.getElementById('iname').value.trim(),url=document.getElementById('iurl').value.trim(),group=document.getElementById('iv').value,role=document.getElementById('irole').value||'main';if(!name){toast('請填寫名稱','warn');return;}if(!url){toast('請填寫串流 URL','warn');return;}try{if(eid){await A.put('/api/streams/'+eid,{id:eid,name,rtsp_url:url,group,role});}else{const newId=group+'-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').substring(0,24)+'-'+Math.random().toString(36).substring(2,6);await A.post('/api/streams',{id:newId,name,rtsp_url:url,group,role});}toast(eid?'已更新':'已新增','ok');closeModal();await load();}catch(e){toast('儲存失敗：'+e.message,'err');}}
  async function delCam(id){const s=st.find(x=>x.id===id);if(!confirm('確定刪除「'+(s?.name||id)+'」？'))return;destroyH('m__'+id);destroyH('p__'+id);await A.del('/api/streams/'+id);toast('已刪除','warn');if(mId===id){mId=null;resetM();}if(pId===id)clearPip();await load();}
  function initPip(){const pip=document.getElementById('pip');let drag=false,rx=0,ry=0;pip.addEventListener('mousedown',e=>{if(e.target.closest('#pip-rsz'))return;drag=true;const r=pip.getBoundingClientRect();rx=e.clientX-r.left;ry=e.clientY-r.top;pip.style.cursor='grabbing';e.preventDefault();});document.addEventListener('mousemove',e=>{if(!drag)return;const s=document.getElementById('stage').getBoundingClientRect();let x=e.clientX-s.left-rx,y=e.clientY-s.top-ry;x=Math.max(0,Math.min(x,s.width-pip.offsetWidth));y=Math.max(0,Math.min(y,s.height-pip.offsetHeight));pip.style.right='auto';pip.style.top='auto';pip.style.left=x+'px';pip.style.top=y+'px';});document.addEventListener('mouseup',()=>{drag=false;pip.style.cursor='grab';});const rsz=document.getElementById('pip-rsz');let res=false,rsx=0,rsy=0,rsw=0;rsz.addEventListener('mousedown',e=>{res=true;rsx=e.clientX;rsy=e.clientY;rsw=pip.offsetWidth;e.stopPropagation();e.preventDefault();});document.addEventListener('mousemove',e=>{if(!res)return;const w=Math.max(160,Math.min(rsw+(e.clientX-rsx),560));pip.style.width=w+'px';pip.style.height=Math.round(w*9/16)+'px';});document.addEventListener('mouseup',()=>{res=false;});}
  function init(){
    loadVessels().then(()=>load());
    setInterval(load,3500);
    initPip();
    // ── Sidebar collapse toggle ──
    const sbToggle=document.getElementById('sb-toggle');
    const sbCIcon=document.getElementById('sb-c-icon');
    function toggleSidebar(){
      const collapsed=document.body.classList.toggle('sb-collapsed');
      sbToggle.textContent=collapsed?'▶':'◀';
      sbToggle.title=collapsed?'展開側欄':'收合側欄';
    }
    if(sbToggle) sbToggle.addEventListener('click',toggleSidebar);
    if(sbCIcon) sbCIcon.addEventListener('click',toggleSidebar);
    document.getElementById('modal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});
    document.getElementById('vmodal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeVModal();});
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'){closeModal();closeVModal();}
      if(e.key==='Enter'){
        if(document.getElementById('modal').classList.contains('open'))saveCam();
        if(document.getElementById('vmodal').classList.contains('open'))saveVessel();
      }
    });
  }
  init();
  return{selV,selM,setPip,setView,startCam,stopCam,startMain,stopMain,startV,stopV,openAdd,openEdit,closeModal,saveCam,delCam,openAddV,openEditV,closeVModal,saveVessel,delVessel};
})();

function pickR(el){document.querySelectorAll('.ro').forEach(o=>o.classList.remove('sel'));el.classList.add('sel');document.getElementById('irole').value=el.dataset.r;}
function pickIcon(el){document.querySelectorAll('.icon-opt').forEach(o=>o.classList.remove('sel'));el.classList.add('sel');const ic=el.dataset.ic;document.getElementById('viicon').value=ic;document.getElementById('vicon-preview').textContent=ic;}
