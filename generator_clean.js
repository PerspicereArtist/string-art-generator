// generator_clean.js
// Clean restart: rectangle string art solver with
// - strict colour scheduling (runLen blocks, least->most remaining, dropouts, tail)
// - no same-edge connections
// - AA line sampling (bilinear weights)
// - global diminishing returns (saturating coverage) to stop corridor lock-in
// - top-K stochastic pick (fade acts like temperature / exploration)
//
// Drop-in for generator_preset_advanced_fade.html (keeps same element IDs).

;(() => {
  'use strict';

  // ---------- DOM helpers ----------
  const $ = (id) => /** @type {HTMLElement} */(document.getElementById(id));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- Residual-hotspot targeting (easy tuning) ----------
  const HOTSPOT_PERCENT = 0.02;
  const HOTSPOT_WEIGHT = 1.5;
  const HOTSPOT_UPDATE_STEPS = 25;

  
  function setInputClamp(id, value){
    const el = /** @type {HTMLInputElement} */($(id));
    if(!el) return;
    const min = (el.min !== '' ? +el.min : -1e9);
    const max = (el.max !== '' ? +el.max :  1e9);
    const step = (el.step !== '' ? +el.step : 0);
    let v = Math.max(min, Math.min(max, value));
    if(step > 0){
      v = Math.round(v/step)*step;
    }
    el.value = String(v);
  }
function setText(id, v){ const el = $(id); if(el) el.textContent = String(v); }
  function uiNum(id){ return +/** @type {HTMLInputElement} */($(id)).value; }
  function uiInt(id){ return Math.round(uiNum(id)); }

  // ---------- Canvas ----------
  const srcCanvas = /** @type {HTMLCanvasElement} */($('srcCanvas'));
  const outCanvas = /** @type {HTMLCanvasElement} */($('outCanvas'));
  const sctx = srcCanvas.getContext('2d', { willReadFrequently:true });
  const octx = outCanvas.getContext('2d', { willReadFrequently:true });

  // Make scaled canvases look crisp (prevents blurry preview when CSS stretches them)
  srcCanvas.style.imageRendering = 'pixelated';
  outCanvas.style.imageRendering = 'pixelated';
  srcCanvas.style.width = '100%';
  srcCanvas.style.height = '100%';
  outCanvas.style.width = '100%';
  outCanvas.style.height = '100%';
  srcCanvas.style.display = 'block';
  outCanvas.style.display = 'block';



  // ---------- Palette UI ----------
  const paletteDiv = $('palette');
  /** @typedef {{hex:string, val:number, name?:string}} PaletteColor */

  function createPaletteRow(hex, val, name){
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '90px 1fr 60px 34px';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.padding = '8px';
    row.style.border = '1px solid var(--border)';
    row.style.borderRadius = '10px';
    row.style.background = 'var(--panel2)';

    const color = document.createElement('input');
    color.type = 'color';
    color.value = hex;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(val);

    const num = document.createElement('input');
    num.type = 'number';
    num.min = '0';
    num.max = '100';
    num.step = '1';
    num.value = String(val);
    num.style.width = '60px';

    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Remove colour';
    del.style.width = '34px';
    del.style.height = '34px';
    del.style.borderRadius = '10px';

    const label = document.createElement('div');
    label.style.fontSize = '12px';
    label.style.color = 'var(--muted)';
    label.textContent = name || '';

    // keep slider + number in sync
    const sync = (v) => {
      const vv = clamp(Math.round(v), 0, 100);
      slider.value = String(vv);
      num.value = String(vv);
    };
    slider.addEventListener('input', ()=> sync(slider.value));
    num.addEventListener('input', ()=> sync(num.value));

    del.addEventListener('click', ()=>{
      row.remove();
      updateGenMeta();
    });

    row.appendChild(color);
    row.appendChild(slider);
    row.appendChild(num);
    row.appendChild(del);
    if(name){
      row.appendChild(document.createElement('div'));
      row.appendChild(label);
    }
    return row;
  }

  
  // ---------- Sequence export compatibility ----------
  // Your legacy replay reader expects:
  //   # color <name>
  //   <pin>
  //   <pin>
  // ... (walk format, one pin per line)
  // and it worked with headers repeating every ~200 moves.
  function colorNameFromHex(hex){
    const h = (hex||'').trim().toLowerCase();
    if(h === '#ffcc33' || h === '#ffcc00' || h === '#ffd200' || h === '#ffd04a') return 'yellow';
    if(h === '#1f66ff' || h === '#0066ff' || h === '#2e6cff' || h === '#3b74ff') return 'blue';
    if(h === '#ffffff' || h === '#fff') return 'white';
    if(h === '#0b0b0c' || h === '#000000' || h === '#111111') return 'black';
    // fallback: try to match by palette dominance later; default to hex
    return h;
  }
  function headerForColorName(name){
    const n = (name||'').toLowerCase();
    return '# color ' + n;
  }
  function hexFromColorName(name){
    const n = (name||'').toLowerCase();
    if(n === 'yellow') return '#ffcc33';
    if(n === 'blue') return '#1f66ff';
    if(n === 'white') return '#ffffff';
    if(n === 'black') return '#0b0b0c';
    // allow hex passthrough
    if(n.startsWith('#')) return n;
    return '#ffffff';
  }

  function validateSequenceText(text){
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let sawHeader = false;
    let pinCountAfterHeader = 0;
    let previousWasHeader = false;

    for(let i=0;i<lines.length;i++){
      const raw = lines[i];
      if(raw === '') continue;

      if(raw.startsWith('#')){
        if(!raw.startsWith('# color ')) return { ok:false, reason:`Invalid header at line ${i+1}: use # color` };
        if(previousWasHeader) return { ok:false, reason:`Repeated headers without pins near line ${i+1}` };
        sawHeader = true;
        pinCountAfterHeader = 0;
        previousWasHeader = true;
        continue;
      }

      if(!/^\d+$/.test(raw)) return { ok:false, reason:`Invalid pin line ${i+1}: expected integer` };
      if(!sawHeader) return { ok:false, reason:`Pin before first # color header at line ${i+1}` };

      pinCountAfterHeader += 1;
      previousWasHeader = false;
    }

    if(!sawHeader) return { ok:false, reason:'Missing # color header' };
    return { ok:true, reason:'ok' };
  }


function getPalette(){
    /** @type {PaletteColor[]} */
    const out = [];
    for(const row of paletteDiv.children){
      const inputs = row.querySelectorAll('input');
      if(inputs.length < 3) continue;
      const hex = /** @type {HTMLInputElement} */(inputs[0]).value;
      const val = +/** @type {HTMLInputElement} */(inputs[2]).value;
      out.push({ hex, val: clamp(val, 0, 100) });
    }
    // keep only active
    return out.filter(c => c.val > 0);
  }

  function ensureDefaultPalette(){
    if(paletteDiv.children.length) return;
    // Default test palette (matches your baseline sliders)
    paletteDiv.appendChild(createPaletteRow('#0b0b0c', 55, 'black'));
    paletteDiv.appendChild(createPaletteRow('#ffffff', 41, 'white'));
    paletteDiv.appendChild(createPaletteRow('#1f66ff', 18, 'blue'));
    paletteDiv.appendChild(createPaletteRow('#ffcc33', 28, 'yellow'));
  }

  $('addColor').addEventListener('click', ()=>{
    paletteDiv.appendChild(createPaletteRow('#ffffff', 10, ''));
    updateGenMeta();
  });

  // ---------- Image handling ----------
  const img = new Image();
  img.crossOrigin = 'anonymous';
  let imgLoaded = false;

  function drawSource(){
    const W = srcCanvas.width, H = srcCanvas.height;
    sctx.clearRect(0,0,W,H);
    sctx.fillStyle = '#000';
    sctx.fillRect(0,0,W,H);
    if(!imgLoaded){
      sctx.fillStyle = '#888';
      sctx.fillText('Load an image…', 12, 20);
      return;
    }
    const scale = uiNum('imgScale'); // direct multiplier
    const offX = uiNum('imgOffX');
    const offY = uiNum('imgOffY');

    // Sliders in the HTML are -1..1 (0 neutral)
    const b = uiNum('brightness');
    const c = uiNum('contrast');
    // Map -1..1 -> 0..200% (0 => 100%)
    const bPct = clamp(100 * (1 + b), 0, 300);
    const cPct = clamp(100 * (1 + c), 0, 300);

    const iw = img.naturalWidth, ih = img.naturalHeight;
    const cx = W/2 + offX;
    const cy = H/2 + offY;
    const dw = iw * scale;
    const dh = ih * scale;

    sctx.save();
    sctx.filter = `brightness(${bPct}%) contrast(${cPct}%)`;
    sctx.drawImage(img, cx - dw/2, cy - dh/2, dw, dh);
    sctx.restore();
  }

  function fitImage(){
    if(!imgLoaded) return;
    // naive fit: scale to cover canvas
    const W = srcCanvas.width, H = srcCanvas.height;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const s = Math.min(W/iw, H/ih) * 0.95;
    /** @type {HTMLInputElement} */($('imgScale')).value = String(Math.round(s*1000)/1000);
    /** @type {HTMLInputElement} */($('imgOffX')).value = '0';
    /** @type {HTMLInputElement} */($('imgOffY')).value = '0';
    setText('imgScaleVal', String(Math.round(s*1000)/1000));
    setText('imgOffXVal', '0');
    setText('imgOffYVal', '0');
    drawSource();
  }

  $('fit').addEventListener('click', fitImage);
  $('resetImg').addEventListener('click', ()=>{
    /** @type {HTMLInputElement} */($('imgScale')).value = '1';
    /** @type {HTMLInputElement} */($('imgOffX')).value = '0';
    /** @type {HTMLInputElement} */($('imgOffY')).value = '0';
    /** @type {HTMLInputElement} */($('brightness')).value = '0';
    /** @type {HTMLInputElement} */($('contrast')).value = '0';
    updateUiLabels();
    drawSource();
  });

  $('imgFile').addEventListener('change', (e)=>{
    const file = /** @type {HTMLInputElement} */(e.target).files?.[0];
    if(!file) return;
    const url = URL.createObjectURL(file);
    img.onload = ()=>{
      imgLoaded = true;
      URL.revokeObjectURL(url);
      drawSource();
      fitImage();
      updateGenMeta();
    };
    img.src = url;
  });

  function updateUiLabels(){
    const pairs = [
      ['wPins','wPinsVal'], ['hPins','hPinsVal'],
      ['imgScale','imgScaleVal'], ['imgOffX','imgOffXVal'], ['imgOffY','imgOffYVal'],
      ['brightness','brightnessVal'], ['contrast','contrastVal'],
      ['fade','fadeVal'], ['angleBal','angleBalVal'], ['farJitter','farJitterVal'],
      ['candK','candKVal'], ['workRes','workResVal'], ['thickness','thicknessVal'],
      ['maxConn','maxConnVal'], ['runLen','runLenVal'],
    ];
    for(const [a,b] of pairs){
      const v = /** @type {HTMLInputElement} */($(a)).value;
      setText(b, v);
    }
  }

  function hookSliders(){
    const ids = ['wPins','hPins','imgScale','imgOffX','imgOffY','brightness','contrast','fade','angleBal','farJitter','candK','workRes','thickness','maxConn','runLen'];
    for(const id of ids){
      const el = /** @type {HTMLInputElement} */($(id));
      el.addEventListener('input', ()=>{
        updateUiLabels();
        if(id.startsWith('img') || id==='brightness' || id==='contrast') drawSource();
        if(id==='wPins' || id==='hPins'){
          // geometry changes won't reflect until next run; make that obvious
          octx.clearRect(0,0,outCanvas.width,outCanvas.height);
          octx.fillStyle = '#000';
          octx.fillRect(0,0,outCanvas.width,outCanvas.height);
          setText('outInfo','(geometry changed — re-run preview/create)');
        }
        updateGenMeta();
      });
    }
  }

  function updateGenMeta(){
    const pal = getPalette();
    const meta = $('genMeta');
    meta.textContent = `Palette colours: ${pal.length} | runLen=${uiInt('runLen')} | maxConn=${uiInt('maxConn')}`;
  }

  // ---------- Geometry: pins on rectangle perimeter ----------
  
  // Build token list (one entry per connection) from palette weights.
  // Stacked mode: colours are grouped, ordered by least quota -> most quota.
  function buildTokensFromPaletteStacked(){
    const rows = Array.from(paletteDiv.querySelectorAll('.palRow'));
    const items = rows.map(r=>{
      const colEl = r.querySelector('input[type=color]');
      const col = (colEl ? colEl.value : '#ffffff').toLowerCase();

      // weight number input is created in createPaletteRow as the last number input
      const nums = Array.from(r.querySelectorAll('input[type=number]'));
      const wEl = nums.length ? nums[nums.length-1] : null;
      const w = wEl ? parseInt(wEl.value||'0',10) : 0;
      return {col, w: Math.max(0, w|0)};
    }).filter(it=>it.w>0);

    // least -> most quota
    items.sort((a,b)=> a.w - b.w || a.col.localeCompare(b.col));

    const toks = [];
    for(const it of items){
      for(let i=0;i<it.w;i++) toks.push(it.col);
    }
    return toks;
  }

function buildPins(wPins, hPins, workW, workH){
    const pins = [];
    const W = wPins, H = hPins;

    // 0 at TOP-RIGHT, indices increase anti-clockwise:
    // top: right->left
    for(let i=W-1;i>=0;i--){
      pins.push({x: i*(workW-1)/(W-1), y: 0, edge:0});
    }
    // left: top->bottom (excluding corners)
    for(let j=1;j<H-1;j++){
      pins.push({x: 0, y: j*(workH-1)/(H-1), edge:3});
    }
    // bottom: left->right
    for(let i=0;i<W;i++){
      pins.push({x: i*(workW-1)/(W-1), y: workH-1, edge:2});
    }
    // right: bottom->top (excluding corners)
    for(let j=H-2;j>=1;j--){
      pins.push({x: workW-1, y: j*(workH-1)/(H-1), edge:1});
    }
    return pins;
  }

  // ---------- Schedule ----------
  function buildSchedule(palette, maxConn, runLen){
    // Stacked palette scheduling: colours are grouped into single blocks,
    // ordered by least quota -> most quota. (No 200-line cycling.)
    const cols = palette.map(p=>({ token:p.hex.toLowerCase(), val:Math.max(0, +p.val || 0) })).filter(c=>c.val>0);
    if(!cols.length){
      return { blocks:[{token:"#000000",len:maxConn}], tokens:new Array(maxConn).fill("#000000") };
    }
    const sumVal = cols.reduce((s,c)=>s+c.val,0) || 1;
    // proportional quotas, then adjust to sum exactly maxConn
    const quotas = cols.map(c=>Math.max(0, Math.round(maxConn*(c.val/sumVal))));
    let qsum = quotas.reduce((s,x)=>s+x,0);
    while(qsum < maxConn){
      // add to largest weight
      let best=0;
      for(let i=1;i<cols.length;i++) if(cols[i].val > cols[best].val) best=i;
      quotas[best]++; qsum++;
    }
    while(qsum > maxConn){
      // remove from largest quota
      let best=0;
      for(let i=1;i<cols.length;i++) if(quotas[i] > quotas[best]) best=i;
      if(quotas[best]===0) break;
      quotas[best]--; qsum--;
    }

    // order by least quota -> most quota
    const order = quotas.map((q,i)=>({i,q, token:cols[i].token})).filter(o=>o.q>0)
      .sort((a,b)=> a.q - b.q || a.token.localeCompare(b.token));

    const blocks = order.map(o=>({token:o.token, len:o.q}));
    const tokens = [];
    for(const b of blocks){
      for(let k=0;k<b.len;k++) tokens.push(b.token);
    }
    // Safety
    if(tokens.length < maxConn){
      const last = tokens.length ? tokens[tokens.length-1] : "#000000";
      while(tokens.length < maxConn) tokens.push(last);
    }
    if(tokens.length > maxConn) tokens.length = maxConn;

    const quotasByColor = Object.create(null);
    for(const o of order) quotasByColor[o.token] = o.q;

    return { blocks, tokens, quotasByColor };
  }

  // ---------- Color utilities ----------
  function hexToRgb(hex){
    const h = hex.replace('#','').trim();
    const n = parseInt(h.length===3 ? h.split('').map(x=>x+x).join('') : h, 16);
    return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
  }

  function buildWorkImage(workW, workH){
    // Draw source to a temp canvas at work resolution
    const tmp = document.createElement('canvas');
    tmp.width = workW; tmp.height = workH;
    const tctx = tmp.getContext('2d', { willReadFrequently:true });
    // scale srcCanvas into work canvas
    tctx.drawImage(srcCanvas, 0,0, workW, workH);
    const id = tctx.getImageData(0,0,workW,workH);
    return id.data; // Uint8ClampedArray RGBA
  }

  function buildColorTargets(workRGBA, workW, workH, palette){
    const N = workW*workH;
    const cols = palette.map(c=>hexToRgb(c.hex));
    const targets = cols.map(()=>new Float32Array(N));

    // Soft membership: inverse distance in RGB, weighted by darkness.
    const EPS = 1e-6;
    const invP = 1/255;
    for(let p=0;p<N;p++){
      const i = p*4;
      const r = workRGBA[i]*invP;
      const g = workRGBA[i+1]*invP;
      const b = workRGBA[i+2]*invP;
      const lum = 0.2126*r + 0.7152*g + 0.0722*b;
      const dark = clamp(1 - lum, 0, 1);
      let sumW = 0;
      // compute similarities
      for(let c=0;c<cols.length;c++){
        const cr = cols[c].r*invP, cg = cols[c].g*invP, cb = cols[c].b*invP;
        const dr = r-cr, dg=g-cg, db=b-cb;
        const dist2 = dr*dr + dg*dg + db*db;
        const w = 1/(EPS + dist2); // closer => bigger
        targets[c][p] = w;
        sumW += w;
      }
      const inv = 1/(sumW+EPS);
      for(let c=0;c<cols.length;c++){
        targets[c][p] = dark * (targets[c][p]*inv);
      }
    }
    return targets;
  }

  // ---------- AA line sampling ----------
  function sampleLineWeights(ax, ay, bx, by, workW, workH){
    // Step along the line in pixel space; for each step, bilinear distribute into 4 neighbours.
    const dx = bx-ax, dy = by-ay;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx,dy)));
    const inv = 1/steps;

    /** @type {Array<[number, number]>} */
    const out = [];
    // small perf: accumulate into a Map for uniqueness
    const map = new Map(); // idx -> weight
    for(let s=0;s<=steps;s++){
      const t = s*inv;
      const x = ax + dx*t;
      const y = ay + dy*t;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;

      for(let oy=0;oy<=1;oy++){
        const yy = y0+oy;
        if(yy<0 || yy>=workH) continue;
        const wy = oy? fy : (1-fy);
        for(let ox=0;ox<=1;ox++){
          const xx = x0+ox;
          if(xx<0 || xx>=workW) continue;
          const wx = ox? fx : (1-fx);
          const w = wx*wy;
          const idx = yy*workW + xx;
          map.set(idx, (map.get(idx)||0) + w);
        }
      }
    }
    map.forEach((w, idx)=> out.push([idx, w]));
    return out;
  }

  // ---------- Candidate generation ----------
  function randInt(n){ return (Math.random()*n)|0; }

  function genCandidates(cur, pins, candK, farJitter){
    const n = pins.length;
    const A = pins[cur];
    const out = new Set();
    const jitter = clamp(farJitter/100, 0, 1);

    // random proposals
    while(out.size < candK){
      const j = randInt(n);
      if(j===cur) continue;
      out.add(j);
    }

    // add some "far" proposals (opposite-ish around perimeter)
    const farBase = (cur + Math.floor(n/2)) % n;
    const spread = Math.floor(n * 0.08 * jitter) + 2;
    for(let t=0;t<Math.min(10, candK); t++){
      let j = farBase + (randInt(spread*2+1)-spread);
      j = ((j%n)+n)%n;
      if(j!==cur) out.add(j);
    }

    // return as array
    return Array.from(out);
  }

  function sameEdge(a, b, pins){ return pins[a].edge === pins[b].edge; }

  function edgeKey(a, b){
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo + '-' + hi;
  }

  function ruleFlag(name, fallback){
    const bag = (typeof window !== 'undefined' && window.__solverRules) ? window.__solverRules : null;
    if(bag && Object.prototype.hasOwnProperty.call(bag, name)) return !!bag[name];
    return fallback;
  }

  function isCornerPin(P, workW, workH){
    const x0 = Math.abs(P.x - 0) < 1e-6;
    const x1 = Math.abs(P.x - (workW - 1)) < 1e-6;
    const y0 = Math.abs(P.y - 0) < 1e-6;
    const y1 = Math.abs(P.y - (workH - 1)) < 1e-6;
    return (x0 || x1) && (y0 || y1);
  }

  function shouldRejectCornerAdjacent(A, B, workW, workH){
    if(!isCornerPin(A, workW, workH) && !isCornerPin(B, workW, workH)) return false;
    // Hard rule: avoid using a corner pin with a pin on one of the corner's adjacent edges.
    if(isCornerPin(A, workW, workH)){
      if(A.edge === 0) return (B.edge === 1 || B.edge === 3);
      if(A.edge === 2) return (B.edge === 1 || B.edge === 3);
    }
    if(isCornerPin(B, workW, workH)){
      if(B.edge === 0) return (A.edge === 1 || A.edge === 3);
      if(B.edge === 2) return (A.edge === 1 || A.edge === 3);
    }
    return false;
  }

  // ---------- Solver core ----------
  async function runSolver({draft, liveDraw=true, renderMul=4}){
    if(!imgLoaded){ alert('Load an image first.'); return; }
    ensureDefaultPalette();
    updateUiLabels();

    const palette = getPalette();
    if(!palette.length){ alert('Add at least one palette colour with value > 0'); return; }

    const wPins = uiInt('wPins');
    const hPins = uiInt('hPins');
    const workRes = uiInt('workRes');
    const maxConn = uiInt('maxConn');
    const runLen = uiInt('runLen');
    const candK = uiInt('candK');
    const farJitter = uiInt('farJitter');
    const fade = uiNum('fade'); // 0..50 exploration
    const angleBal = uiNum('angleBal'); // 0..50
    const thickness = uiNum('thickness'); // used only in preview draw
    const f = clamp(fade/50, 0, 1);

    // Work canvas size: keep aspect by hPins/wPins
    const aspect = (hPins-1)/(wPins-1);
    const workW = workRes;
    const workH = Math.max(16, Math.round(workRes * aspect));
    const N = workW*workH;

    // pins
    const pins = buildPins(wPins, hPins, workW, workH);
    const nPins = pins.length;

    // targets/residuals
    setText('statusRight', 'Building targets…');
    const workRGBA = buildWorkImage(workW, workH);
    const targets = buildColorTargets(workRGBA, workW, workH, palette);
    const residuals = targets.map(t=>new Float32Array(t));
    const globalCov = new Float32Array(N);

    // schedule tokens (colour blocks)
    const sched = buildSchedule(palette, maxConn, runLen);
    const tokens = sched.tokens;

    // ---- per-colour adaptive state (scaffold -> detail)
    const tokenLen = Object.create(null);
    for(const b of sched.blocks){ tokenLen[b.token.toLowerCase()] = b.len; }

    /** @type {{mode:0|1, blockLen:number, blockPos:number, scores:number[], newfracs:number[], bestAvg:number, hotspotX:number, hotspotY:number, nextHotAt:number, hotspotMask:Uint8Array}[]} */
    const colourState = palette.map(p => ({
      mode: 0,
      blockLen: tokenLen[p.hex.toLowerCase()] || 0,
      blockPos: 0,
      scores: [],
      newfracs: [],
      bestAvg: 0,
      hotspotX: workW * 0.5,
      hotspotY: workH * 0.5,
      nextHotAt: 0,
      hotspotMask: new Uint8Array(N)
    }));

    // Rule flags are treated as hard constraints during candidate filtering (reject, never penalize).
    const noSameEdgeConnections = ruleFlag('noSameEdgeConnections', true);
    const noSameRowOrColumn = ruleFlag('noSameRowOrColumn', false);
    const cornerAvoidsAdjacentEdges = ruleFlag('cornerAvoidsAdjacentEdges', false);

    // Backtracking prevention state: previous segment start pin for A->B->A rejection.
    let prevPrevPin = -1;

    // Highway suppression state: track recent edge usage counts in a sliding window.
    const HIGHWAY_WINDOW = 400;
    const recentEdgeQueue = [];
    const recentEdgeCounts = new Map();

    function updateHotspotForColour(cIdx){
      const resid = residuals[cIdx];
      const st = colourState[cIdx];
      const mask = st.hotspotMask;
      mask.fill(0);

      const take = Math.max(1, Math.floor(N * HOTSPOT_PERCENT));
      const topVals = [];
      for(let i=0;i<N;i++){
        const v = resid[i];
        if(topVals.length < take){
          topVals.push(v);
          if(topVals.length === take) topVals.sort((a,b)=>a-b);
          continue;
        }
        if(v > topVals[0]){
          topVals[0] = v;
          // keep ascending with tiny insertion pass (k is small enough in practice)
          let j = 0;
          while(j+1<topVals.length && topVals[j] > topVals[j+1]){
            const t = topVals[j];
            topVals[j] = topVals[j+1];
            topVals[j+1] = t;
            j++;
          }
        }
      }

      const threshold = topVals.length ? topVals[0] : 0;
      let sumX = 0, sumY = 0, count = 0;
      for(let i=0;i<N;i++){
        if(resid[i] >= threshold){
          mask[i] = 1;
          sumX += (i % workW);
          sumY += ((i / workW) | 0);
          count++;
        }
      }

      if(count > 0){
        st.hotspotX = sumX / count;
        st.hotspotY = sumY / count;
      }
    }



    // angle histogram
    const ANG_BINS = 36;
    const angHist = new Uint32Array(ANG_BINS);
    const angFill = new Float32Array(ANG_BINS);
    const ANG_WINDOW = 500;
    const recentAngleQueue = [];
    const recentAngleCounts = new Uint16Array(ANG_BINS);

    // helper: angle bin for a segment (0..pi)
    function angleBin(ax,ay,bx,by){
      let a = Math.atan2(by-ay, bx-ax);
      if(a<0) a += Math.PI;
      if(a>=Math.PI) a -= Math.PI;
      let b = Math.floor(a / Math.PI * ANG_BINS);
      if(b<0) b=0; if(b>=ANG_BINS) b=ANG_BINS-1;
      return b;
    }

    // stochastic choose from topK
    function chooseTopK(list, temperature){
      if(list.length===1) return list[0];
      // weights = exp(score / temp)
      const t = Math.max(1e-6, temperature);
      let sum = 0;
      const ws = new Float32Array(list.length);
      for(let i=0;i<list.length;i++){
        const w = Math.exp(list[i].score / t);
        ws[i]=w; sum += w;
      }
      let r = Math.random()*sum;
      for(let i=0;i<list.length;i++){
        r -= ws[i];
        if(r<=0) return list[i];
      }
      return list[list.length-1];
    }

    // main selection function
    
function pickBestNext(curPin, cIdx){
      const resid = residuals[cIdx];
      const st = colourState[cIdx];

      const candidates = genCandidates(curPin, pins, candK, farJitter);
      /** @type {{pin:number, score:number, bin:number, idxs:Array<[number,number]>, newFrac:number}[]} */
      const scored = [];
      const A = pins[curPin];

      const temp = 0.03 + 0.25*f; // higher fade => more exploration
      const isDetail = (st.mode === 1);
      const HIGHWAY_PENALTY_K = 0.22; // easy tuning knob for corridor/highway suppression

      // refresh hotspot on a fixed cadence (every N steps)
      if(st.blockPos >= st.nextHotAt){
        updateHotspotForColour(cIdx);
        st.nextHotAt = st.blockPos + HOTSPOT_UPDATE_STEPS;
      }

      for(const cand of candidates){
        if(cand===curPin) continue;

        // Hard ban immediate backtracking: reject A -> B -> A.
        if(prevPrevPin >= 0 && cand === prevPrevPin) continue;

        const B = pins[cand];

        // Hard rule enforcement (enabled flags must reject candidates, not penalize score).
        if(noSameEdgeConnections && sameEdge(curPin, cand, pins)) continue;
        if(noSameRowOrColumn && (Math.abs(A.x - B.x) < 1e-6 || Math.abs(A.y - B.y) < 1e-6)) continue;
        if(cornerAvoidsAdjacentEdges && shouldRejectCornerAdjacent(A, B, workW, workH)) continue;

        const idxs = sampleLineWeights(A.x, A.y, B.x, B.y, workW, workH);

        // base score = average effective improvement after diminishing returns
        let sum = 0;
        let sumHi = 0;
        let sumW = 0;
        let sumNew = 0;

        for(const [idx, wt] of idxs){
          const cov = globalCov[idx];
          const eff = (1 - cov); // diminishing returns
          const r = resid[idx];

          sum += r * wt * eff;
          if(isDetail){
            // emphasise remaining peaks (late-stage detail)
            sumHi += (r * r / 255) * wt * eff;
          }
          sumNew += wt * eff;
          sumW += wt;
        }
        if(sumW>0){
          sum /= sumW;
          if(isDetail) sumHi /= sumW;
        }

        let s = sum;

        // detail blend
        if(isDetail){
          const alpha = 0.65; // how strongly to push peak residuals
          s = (1 - alpha) * sum + alpha * sumHi;

          // compress very long chords to avoid corridor domination
          const dx = (B.x - A.x), dy = (B.y - A.y);
          const len = Math.sqrt(dx*dx + dy*dy);
          const lenN = len / Math.max(workW, workH); // ~0..1
          s *= 1.0 / (1.0 + 2.0 * lenN);
        }

        // hotspot guidance: reward sampled pixels that intersect top residual hotspots.
        let hotspotHits = 0;
        const hotspotMask = st.hotspotMask;
        for(const [idx] of idxs){
          if(hotspotMask[idx]) hotspotHits += 1;
        }
        s += hotspotHits * HOTSPOT_WEIGHT;

        // Highway suppression (soft): penalize edges that were used often in the recent window.
        const eKey = edgeKey(curPin, cand);
        const recentCount = recentEdgeCounts.get(eKey) || 0;
        s -= HIGHWAY_PENALTY_K * recentCount;

        // angle balancing (lightweight): discourage bins that are overused
        const bin = angleBin(A.x,A.y,B.x,B.y);
        const bal = clamp(angleBal/50, 0, 1);
        if(bal>0){
          const recent = recentAngleCounts[bin];
          const fill = (angFill[bin] / (1 + angHist[bin])) + (recent / Math.max(1, ANG_WINDOW));
          s *= 1.0 / (1.0 + bal * 2.2 * fill);
        }

        const newFrac = (sumW>0) ? (sumNew / sumW) : 0;
        scored.push({pin:cand, score:s, bin, idxs, newFrac});
      }

      if(!scored.length) return null;
      scored.sort((a,b)=> b.score - a.score);
      const K = Math.min(12, scored.length);
      const top = scored.slice(0, K);
      return (f>0.02) ? chooseTopK(top, temp) : top[0];
    }

    // apply a chosen line (global diminishing returns)
    function applyLine(cIdx, idxs, strength){
      const resid = residuals[cIdx];
      for(const [idx, wt] of idxs){
        const cov = globalCov[idx];
        const add = strength * wt * (1 - cov);
        const eff = Math.min(resid[idx], add);
        resid[idx] = Math.max(0, resid[idx] - eff);
        globalCov[idx] = cov + eff * (1 - cov); // saturating
      }
    }

    // preview render state
    // Keep the canvas buffer size from HTML (e.g. 900x900) and scale drawing to fill it.
    const bufW = outCanvas.width;
    const bufH = outCanvas.height;
    const sX = bufW / workW;
    const sY = bufH / workH;
    const S = Math.min(sX, sY); // uniform scale
    const padX = (bufW - workW*S) * 0.5;
    const padY = (bufH - workH*S) * 0.5;

    octx.setTransform(1,0,0,1,0,0);
    octx.clearRect(0,0,bufW,bufH);
    octx.fillStyle = '#000';
    octx.fillRect(0,0,bufW,bufH);

    // Work-space -> canvas-space transform
    octx.setTransform(S, 0, 0, S, padX, padY);

    // sequence output buffer
    /** @type {string[]} */
    const seqLines = [];
    let curTok = '';
    let curPin = randInt(nPins);

    // base strength: draft slightly stronger per-step so preview looks meaningful
    const baseStrength = 0.045; // consistent preview/create

    let lastYield = performance.now();

    setText('statusLeft', `Pins: ${nPins} | Work: ${workW}×${workH}`);
    setText('statusRight', `Running ${draft?'preview':'create'}…`);

    for(let s=0; s<tokens.length; s++){
      const tok = tokens[s];
      // map token -> colour index in current palette list
      let cIdx = -1;
      for(let i=0;i<palette.length;i++) if(palette[i].hex.toLowerCase()===tok.toLowerCase()) { cIdx=i; break; }
      if(cIdx<0) continue;

      // new colour block header
      if(tok !== curTok){
        curTok = tok;
        // reset per-colour block position for adaptive switching
        if(cIdx >= 0 && colourState[cIdx]){
          colourState[cIdx].blockPos = 0;
          colourState[cIdx].scores.length = 0;
          colourState[cIdx].newfracs.length = 0;
          colourState[cIdx].bestAvg = 0;
          colourState[cIdx].mode = 0;
          colourState[cIdx].nextHotAt = 0;
        }
        const cname = colorNameFromHex(tok);
        seqLines.push(headerForColorName(cname));
        seqLines.push(String(curPin));
      }

      const pick = pickBestNext(curPin, cIdx);
      if(!pick){
        // if stuck, jump
        curPin = randInt(nPins);
        continue;
      }

      // apply
      applyLine(cIdx, pick.idxs, baseStrength);

      // Highway suppression bookkeeping: maintain counts in a recent sliding edge window.
      const usedEdge = edgeKey(curPin, pick.pin);
      recentEdgeQueue.push(usedEdge);
      recentEdgeCounts.set(usedEdge, (recentEdgeCounts.get(usedEdge) || 0) + 1);
      if(recentEdgeQueue.length > HIGHWAY_WINDOW){
        const dropped = recentEdgeQueue.shift();
        if(dropped !== undefined){
          const c = (recentEdgeCounts.get(dropped) || 0) - 1;
          if(c > 0) recentEdgeCounts.set(dropped, c);
          else recentEdgeCounts.delete(dropped);
        }
      }

      // Backtracking prevention state update for next move.
      prevPrevPin = curPin;

      // ---- adaptive phase switch per colour (A: based on "stopped finding new work")
      const st = colourState[cIdx];
      st.blockPos += 1;
      // track rolling improvement + novelty
      st.scores.push(pick.score);
      if(st.scores.length > 50) st.scores.shift();
      st.newfracs.push(pick.newFrac);
      if(st.newfracs.length > 50) st.newfracs.shift();

      if(st.scores.length >= 20){
        const avgScore = st.scores.reduce((a,b)=>a+b,0) / st.scores.length;
        const avgNew  = st.newfracs.reduce((a,b)=>a+b,0) / st.newfracs.length;

        if(avgScore > st.bestAvg) st.bestAvg = avgScore;

        const mature = (st.blockLen>0) ? (st.blockPos / st.blockLen) : 0;
        // Switch when: mature enough + improvement collapsed + novelty collapsed
        if(st.mode === 0 && mature > 0.35 && st.bestAvg > 0){
          if(avgScore < st.bestAvg * 0.32 && avgNew < 0.28){
            st.mode = 1;
            st.nextHotAt = st.blockPos; // refresh hotspot immediately
          }
        }
      }

      // update angle stats
      angHist[pick.bin] += 1;
      angFill[pick.bin] += pick.score;
      recentAngleQueue.push(pick.bin);
      recentAngleCounts[pick.bin] += 1;
      if(recentAngleQueue.length > ANG_WINDOW){
        const oldBin = recentAngleQueue.shift();
        if(oldBin !== undefined && recentAngleCounts[oldBin] > 0) recentAngleCounts[oldBin] -= 1;
      }

      // draw
      const A = pins[curPin];
      const B = pins[pick.pin];
      octx.globalAlpha = clamp(baseStrength * 2.6, 0.05, 0.22); // match replay-ish visibility
      octx.strokeStyle = tok;
      octx.lineWidth = Math.max(0.15, thickness / 30);
      octx.beginPath();
      octx.moveTo(A.x+0.5, A.y+0.5);
      octx.lineTo(B.x+0.5, B.y+0.5);
      octx.stroke();
      octx.globalAlpha = 1;

      // sequence: next pin
      curPin = pick.pin;
      seqLines.push(String(curPin));

      // UI updates / yielding
      if((s % 50) === 0){
        setText('outInfo', `${s}/${tokens.length} lines`);
        setText('pinInfo', `Pin: ${curPin}`);
      }
      const now = performance.now();
      if(now - lastYield > 20){
        lastYield = now;
        await new Promise(r=>setTimeout(r,0));
      }
    }

    // If we didn't live-draw, render from the exported sequence (matches replay reader)
    if(!liveDraw){
      // parse seqLines in our export format: "# color HEX", then starting pin, then pins
      octx.setTransform(1,0,0,1,0,0);
      octx.clearRect(0,0,outCanvas.width,outCanvas.height);
      octx.fillStyle = '#000';
      octx.fillRect(0,0,outCanvas.width,outCanvas.height);
      // Re-apply work-space -> canvas-space transform set at start of runSolver
      octx.setTransform(S, 0, 0, S, padX, padY);

      let curColor = '#ffffff';
      let lastPin = null;
      for(const line of seqLines){
        if(!line) continue;
        if(line.startsWith('# color ') || line.startsWith('# colour ')){
          const hdr = line.startsWith('# colour ') ? line.slice(9).trim() : line.slice(8).trim();
          // hdr may be a hex or a legacy name
          curColor = hdr.startsWith('#') ? hdr : hexFromColorName(hdr);
          lastPin = null;
          continue;
        }
        const pin = parseInt(line, 10);
        if(!Number.isFinite(pin)) continue;
        if(lastPin === null){
          lastPin = pin;
          continue;
        }
        const A = pins[lastPin];
        const B = pins[pin];
        octx.globalAlpha = clamp(baseStrength * 6.0, 0.03, 0.28);
        octx.strokeStyle = curColor;
        octx.lineWidth = Math.max(0.5, thickness);
        octx.beginPath();
        octx.moveTo(A.x + 0.5, A.y + 0.5);
        octx.lineTo(B.x + 0.5, B.y + 0.5);
        octx.stroke();
        lastPin = pin;
      }
      octx.globalAlpha = 1;
    }


    function validateSequence(lines){
      const segments = [];
      let lastPin = null;
      for(const line of lines){
        if(!line) continue;
        if(line.startsWith('# color ') || line.startsWith('# colour ')){
          lastPin = null;
          continue;
        }
        const pin = parseInt(line, 10);
        if(!Number.isFinite(pin)) continue;
        if(lastPin === null){
          lastPin = pin;
          continue;
        }
        segments.push([lastPin, pin]);
        lastPin = pin;
      }

      let backtrackViolations = 0;
      let ruleViolations = 0;

      for(let i=1; i<segments.length; i++){
        const p = segments[i-1];
        const q = segments[i];
        if(p[0] === q[1] && p[1] === q[0]) backtrackViolations += 1;
      }

      for(const seg of segments){
        const a = seg[0], b = seg[1];
        const A = pins[a], B = pins[b];
        if(noSameEdgeConnections && sameEdge(a, b, pins)) ruleViolations += 1;
        if(noSameRowOrColumn && (Math.abs(A.x - B.x) < 1e-6 || Math.abs(A.y - B.y) < 1e-6)) ruleViolations += 1;
        if(cornerAvoidsAdjacentEdges && shouldRejectCornerAdjacent(A, B, workW, workH)) ruleViolations += 1;
      }

      console.log('[validateSequence] segments=', segments.length,
        'A-B-A violations=', backtrackViolations,
        'rule violations=', ruleViolations);
    }

    validateSequence(seqLines);

    const seqText = seqLines.join('\n');
    const seqCheck = validateSequenceText(seqText);
    if(!seqCheck.ok){
      alert('Sequence export validation failed: ' + seqCheck.reason);
      throw new Error('Sequence export validation failed: ' + seqCheck.reason);
    }

    setText('statusRight', 'Done.');
    setText('outInfo', `Done (${tokens.length} lines).`);

    return { seqText, workW, workH };
  }

  
  // ---------- Mouse pan/zoom on source canvas ----------
  function initMousePanZoom(){
    let dragging = false;
    let startX = 0, startY = 0;
    let startOffX = 0, startOffY = 0;

    const getScale = () => uiNum('imgScale'); // slider is treated as direct multiplier
    const setScale = (v) => setInputClamp('imgScale', v);

    // If the HTML offset sliders have tiny ranges (e.g. -1..1), expand them so mouse dragging is useful.
    const offXEl = /** @type {HTMLInputElement} */($('imgOffX'));
    const offYEl = /** @type {HTMLInputElement} */($('imgOffY'));
    const maybeExpand = (el, fallbackMax)=>{
      const min = (el.min!==''? +el.min : -1);
      const max = (el.max!==''? +el.max :  1);
      if(max - min <= 4){
        el.min = String(-fallbackMax);
        el.max = String( fallbackMax);
        if(!el.step || +el.step===0) el.step = '1';
      }
    };
    // Use canvas size as a sensible range.
    maybeExpand(offXEl, Math.max(200, srcCanvas.width));
    maybeExpand(offYEl, Math.max(200, srcCanvas.height));

    const setOff = (ox, oy) => {
      // Do NOT clamp offsets; allow full pan. Keep within expanded slider range.
      offXEl.value = String(ox);
      offYEl.value = String(oy);
    };

    function onDown(e){
      if(!imgLoaded) return;
      dragging = true;
      srcCanvas.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      startOffX = uiNum('imgOffX');
      startOffY = uiNum('imgOffY');
      e.preventDefault();
    }

    function onMove(e){
      if(!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setOff(startOffX + dx, startOffY + dy);
      updateUiLabels();
      drawSource();
      e.preventDefault();
    }

    function endDrag(e){
      if(!dragging) return;
      dragging = false;
      try{ srcCanvas.releasePointerCapture(e.pointerId); }catch(_){}
      e.preventDefault();
    }

    function onWheel(e){
      if(!imgLoaded) return;
      // zoom around cursor
      const rect = srcCanvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (srcCanvas.width / rect.width);
      const my = (e.clientY - rect.top)  * (srcCanvas.height / rect.height);

      const scale0 = getScale();
      const offX0 = uiNum('imgOffX');
      const offY0 = uiNum('imgOffY');

      const iw = img.naturalWidth, ih = img.naturalHeight;
      const cx0 = srcCanvas.width/2 + offX0;
      const cy0 = srcCanvas.height/2 + offY0;
      const dw0 = iw * scale0;
      const dh0 = ih * scale0;

      // Image-space coordinate under cursor (in source image pixels)
      const ix = (mx - (cx0 - dw0/2)) / scale0;
      const iy = (my - (cy0 - dh0/2)) / scale0;

      // Wheel direction: negative deltaY zoom in
      const z = Math.exp(-e.deltaY * 0.0012); // smooth zoom
      let scale1 = scale0 * z;

      // clamp via input attributes
      const scaleEl = /** @type {HTMLInputElement} */($('imgScale'));
      const minS = (scaleEl.min !== '' ? +scaleEl.min : 0.05);
      const maxS = (scaleEl.max !== '' ? +scaleEl.max : 50);
      scale1 = Math.max(minS, Math.min(maxS, scale1));

      const dw1 = iw * scale1;
      const dh1 = ih * scale1;

      // Solve offsets so (ix,iy) stays under cursor
      const offX1 = mx - srcCanvas.width/2 + dw1/2 - ix*scale1;
      const offY1 = my - srcCanvas.height/2 + dh1/2 - iy*scale1;

      setScale(scale1);
      setOff(offX1, offY1);
      updateUiLabels();
      drawSource();
      e.preventDefault();
    }

    srcCanvas.style.touchAction = 'none';
    srcCanvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    srcCanvas.addEventListener('wheel', onWheel, { passive:false });
  }

// ---------- Buttons ----------
  $('preview').addEventListener('click', async ()=>{
    try{
      const r = await runSolver({draft:false, liveDraw:false, renderMul:4});
      // keep latest in memory for create download convenience
      let text = (r && r.seqText) || '';
      if(text.indexOf('\\n') !== -1 && text.indexOf('\n') === -1){
        text = text.replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n');
      }
      window.__lastSequenceText = text;
    }catch(err){
      console.error(err);
      alert(String(err));
    }
  });

  $('create').addEventListener('click', async ()=>{
    try{
      const r = await runSolver({draft:false});
      let text = (r && r.seqText) || '';
      // Safety: if something accidentally escaped newlines ("\\n"), restore real line breaks for legacy readers.
      if(text.indexOf('\\n') !== -1 && text.indexOf('\n') === -1){
        text = text.replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n');
      }
      window.__lastSequenceText = text;
      const blob = new Blob([text], {type:'text/plain'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const dt = new Date();
      const stamp = dt.toISOString().replace(/[:.]/g,'').slice(0,15);
      a.download = `sequence_${uiInt('wPins')}x${uiInt('hPins')}_${uiInt('maxConn')}_${stamp}.txt`;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
    }catch(err){
      console.error(err);
      alert(String(err));
    }
  });

  $('clearOut').addEventListener('click', ()=>{
    octx.clearRect(0,0,outCanvas.width,outCanvas.height);
    octx.fillStyle = '#000';
    octx.fillRect(0,0,outCanvas.width,outCanvas.height);
    setText('outInfo','');
    setText('statusRight','Cleared output.');
  });

  
  // ---------- Test preset (auto-load + default sliders) ----------
  function applyTestPreset(){
    // Only apply on first load of the page (avoid overwriting user changes mid-session).
    // If you want to re-apply, just hit Reset in the UI.
    const set = (id, v) => {
      const el = /** @type {HTMLInputElement} */($(id));
      if(!el) return;
      el.value = String(v);
    };

    // Frame / run defaults
    set('wPins', 100);
    set('hPins', 100);
    set('workRes', 128);
    set('maxConn', 5400);
    set('runLen', 200);
    set('fade', 10);
    set('thickness', 0.2);

    // Image transform defaults (your baseline)
    set('imgScale', 1.57);
    set('imgOffX', -5.426);
    set('imgOffY', 384.547);
    set('brightness', 0);
    set('contrast', 0.7);

    updateUiLabels();
    updateGenMeta();
  }

  function autoLoadTestImage(){
    // Load from same folder as HTML/JS. Add cache-bust so refresh always re-evaluates.
    const url = 'test_source.png?v=' + Date.now();
    setText('statusRight', 'Auto-loading test_source.png…');
    img.onload = ()=>{
      imgLoaded = true;
      setText('statusRight', 'Loaded test_source.png');
      drawSource();
      updateGenMeta();
    };
  }


// ---------- Init ----------
  ensureDefaultPalette();
  hookSliders();
  applyTestPreset();
  updateUiLabels();
  updateGenMeta();
  initMousePanZoom();
  autoLoadTestImage();
  drawSource();
})();
