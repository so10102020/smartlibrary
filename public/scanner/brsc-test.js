(function(){
  'use strict';
  const auth = () => firebase.auth();
  const db = () => firebase.firestore();

  let html5QrCode = null;
  let running = false;
  let lastIsbn = '';
  let lastScanTime = 0; // 連続スキャン防止用

  let nativeStream = null;
  let rafId = null;

  let currentScannerType = null;
  let currentDeviceId = null;
  let codeReader = null;
  
  // 連続スキャン統計
  let scanCount = 0;
  let successCount = 0;

  // DOM util
  const $ = (id) => document.getElementById(id);
  const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  function showSection(id, show=true){ const el = $(id); if (el) el.style.display = show ? 'block' : 'none'; }

  function showActionResult(title, html, type='info'){
    const resultEl = $('actionResult');
    if (!resultEl) return;
    let className = 'result-card';
    let icon = '📋';
    switch(type){
      case 'success': className += ' success'; icon = '✅'; break;
      case 'error': className += ' error'; icon = '❌'; break;
      case 'warning': className += ' warning'; icon = '⚠️'; break;
      case 'processing': className += ' processing'; icon = '⏳'; break;
    }
    resultEl.className = className;
    resultEl.innerHTML = `<h3>${icon} ${title}</h3><div>${html}</div>`;
    showSection('actionResultSection', true);
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // 統計更新
  function updateScanStats(success = true){
    scanCount++;
    if (success) successCount++;
    const statsEl = $('scanStats');
    if (statsEl) {
      statsEl.innerHTML = `📊 スキャン: ${scanCount}回 | 成功: ${successCount}回 | 成功率: ${scanCount > 0 ? Math.round(successCount/scanCount*100) : 0}%`;
    }
  }

  // ビープ音（成功/エラー）
  function playBeep(success = true){
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.value = success ? 1000 : 400; // 成功=高音、エラー=低音
      oscillator.type = 'sine';
      
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch(e) {
      console.warn('Beep failed:', e);
    }
  }

  // バイブレーション
  function vibrate(pattern = [50]){
    try {
      if (navigator.vibrate) {
        navigator.vibrate(pattern);
      }
    } catch(e) {}
  }

  // ISBN helpers
  function toIsbn13(code){
    const digits = (code || '').replace(/[^0-9Xx]/g, '');
    if (digits.length === 13) return digits;
    if (digits.length !== 10) return '';
    const core = '978' + digits.substring(0,9);
    let sum = 0;
    for (let i=0;i<core.length;i++){
      const n = parseInt(core[i],10);
      sum += (i % 2 === 0) ? n : n*3;
    }
    const cd = (10 - (sum % 10)) % 10;
    return core + String(cd);
  }
  function normalizeIsbn(text){
    const raw = (text || '').replace(/[^0-9Xx]/g, '');
    if (raw.length === 13) return /^97[89]/.test(raw) ? raw : '';
    if (raw.length === 10) return toIsbn13(raw);
    return '';
  }

  function extractIsbn13(raw){
    if (!raw) return '';
    let text = String(raw).replace(/^\s*ISBN(?:-1[03])?:?\s*/i, '').replace(/[-\s]/g, '');
    let m13 = text.match(/\b(97[89]\d{10})\b/) || String(raw).match(/\b(97[89]\d{10})\b/);
    if (m13) return m13[1];
    let m10 = text.match(/\b(\d{9}[\dXx])\b/) || String(raw).match(/\b(\d{9}[\dXx])\b/);
    if (m10) return toIsbn13(m10[1]);
    const digits = String(raw).replace(/[^0-9Xx]/g, '');
    if (digits.length === 13 && /^97[89]/.test(digits)) return digits;
    if (digits.length === 10) return toIsbn13(digits);
    return '';
  }

  async function fetchIsbnMeta(isbn13){
    try {
      const r = await fetch(`https://openlibrary.org/isbn/${isbn13}.json`);
      if (r.ok){
        const j = await r.json();
        return {
          isbn13,
          title: j.title || '',
          authors: Array.isArray(j.authors) ? j.authors.map(a=>a.name || a.key).join(', ') : '',
          publisher: Array.isArray(j.publishers) ? j.publishers.map(p=>p.name || p).join(', ') : '',
          published: j.publish_date || ''
        };
      }
    } catch {}
    try {
      const r2 = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}`);
      if (r2.ok){
        const j2 = await r2.json();
        const item = (j2.items && j2.items[0]) ? j2.items[0].volumeInfo : null;
        if (item){
          return {
            isbn13,
            title: item.title || '',
            authors: (item.authors || []).join(', '),
            publisher: item.publisher || '',
            published: item.publishedDate || ''
          };
        }
      }
    } catch {}
    return { isbn13, title: '', authors: '', publisher: '', published: '' };
  }

  async function getBookByIsbn(isbn13){
    let snap = await db().collection('books').where('isbn13','==',isbn13).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() };
    snap = await db().collection('books').where('isbn','==',isbn13).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, data: snap.docs[0].data() };
    return null;
  }

  async function getBookByAny(input){
    const raw = String(input || '').trim();
    const isbn13 = extractIsbn13(raw);
    if (isbn13){
      const byIsbn = await getBookByIsbn(isbn13);
      if (byIsbn) return { ...byIsbn, isbn13 };
    }

    const code = raw.replace(/\s+/g,'').replace(/^ISBN(?:-1[03])?:?/i,'');

    try {
      const doc = await db().collection('books').doc(code).get();
      if (doc.exists) return { id: doc.id, data: doc.data(), isbn13: doc.data()?.isbn13 || null };
    } catch {}

    let snap = await db().collection('books').where('book_id','==', code).limit(1).get();
    if (!snap.empty){ const d=snap.docs[0]; return { id:d.id, data:d.data(), isbn13: d.data()?.isbn13 || null }; }

    snap = await db().collection('books').where('barcode','==', code).limit(1).get();
    if (!snap.empty){ const d=snap.docs[0]; return { id:d.id, data:d.data(), isbn13: d.data()?.isbn13 || null }; }

    return null;
  }

  async function autoCheckoutOrReturnByBook(bookObj, meta){
    const user = auth().currentUser;
    if (!user){ 
      showActionResult('ログインが必要です','<p>先にログインしてください。</p>','error');
      playBeep(false);
      updateScanStats(false);
      return; 
    }
    if (!bookObj){ 
      showActionResult('未登録の資料','<p>この識別子の蔵書は登録されていません。</p>','warning');
      playBeep(false);
      updateScanStats(false);
      return; 
    }

    const { id: bookId, data: b, isbn13 } = bookObj;
    const bookRef = db().collection('books').doc(bookId);

    const q = await db().collection('loans')
      .where('uid','==', user.uid)
      .where('book_id','==', bookId)
      .where('status','==','active')
      .orderBy('created_at','desc')
      .limit(1)
      .get();

    if (!q.empty){
      const loanDoc = q.docs[0].ref;
      await db().runTransaction(async (tx)=>{
        const bSnap = await tx.get(bookRef);
        if (!bSnap.exists) throw new Error('蔵書が見つかりません');
        const data = bSnap.data() || {};
        const available = Number(data.available_count ?? data.stock_available ?? 0);
        tx.update(bookRef, { available_count: available + 1, updated_at: firebase.firestore.FieldValue.serverTimestamp() });
        tx.update(loanDoc, { status: 'returned', returned_at: firebase.firestore.FieldValue.serverTimestamp() });
      });
      showActionResult('📥 返却完了', `
        <p><strong>書名:</strong> ${escapeHtml(b?.title || '不明')}</p>
        <p><strong>ISBN:</strong> ${escapeHtml(isbn13 || bookId)}</p>
      `, 'success');
      playBeep(true);
      vibrate([50, 50, 50]);
      updateScanStats(true);
      return;
    }

    try {
      await db().runTransaction(async (tx)=>{
        const bSnap = await tx.get(bookRef);
        if (!bSnap.exists) throw new Error('蔵書が見つかりません');
        const data = bSnap.data() || {};
        const available = Number(data.available_count ?? data.stock_available ?? 0);
        if (available <= 0) throw new Error('在庫がありません');

        tx.update(bookRef, { available_count: available - 1, updated_at: firebase.firestore.FieldValue.serverTimestamp() });
        const loanRef = db().collection('loans').doc();
        tx.set(loanRef, {
          uid: user.uid,
          book_id: bookId,
          isbn13: isbn13 || data.isbn13 || null,
          book_title: data.title || meta?.title || '',
          checked_out_at: firebase.firestore.FieldValue.serverTimestamp(),
          due_at: null,
          returned_at: null,
          status: 'active',
          created_at: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      showActionResult('📤 貸出完了', `
        <p><strong>書名:</strong> ${escapeHtml(bookObj.data?.title || '不明')}</p>
        <p><strong>ISBN:</strong> ${escapeHtml(isbn13 || bookId)}</p>
      `, 'success');
      playBeep(true);
      vibrate([100]);
      updateScanStats(true);
    } catch (e) {
      showActionResult('貸出失敗', `<p>${escapeHtml(e.message || '処理に失敗しました')}</p>`, 'error');
      playBeep(false);
      updateScanStats(false);
    }
  }

  function escapeHtml(str){
    return String(str ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  // スキャン結果の処理（重複防止強化）
  async function handleDecoded(text){
    const now = Date.now();
    const isbn13 = extractIsbn13(text);
    const disp = isbn13 || String(text).replace(/^\s*ISBN(?:-1[03])?:?/i,'').replace(/[-\s]/g,'');
    
    // 同一コードを500ms以内に再スキャンした場合は無視
    if (disp === lastIsbn && (now - lastScanTime) < 500) return;
    
    lastIsbn = disp;
    lastScanTime = now;

    setText('rawOcrText', disp);
    setText('ocrProgress', '📖 処理中...');

    const meta = isbn13 ? await fetchIsbnMeta(isbn13).catch(()=>null) : null;

    let bookObj = null;
    if (isbn13) {
      const byIsbn = await getBookByIsbn(isbn13);
      if (byIsbn) bookObj = { ...byIsbn, isbn13 };
    }
    if (!bookObj) {
      bookObj = await getBookByAny(text);
    }

    await autoCheckoutOrReturnByBook(bookObj, meta);
    
    // 連続スキャンのため、すぐに次の準備
    setTimeout(() => {
      setText('ocrProgress', '📷 スキャン待機中（次のバーコードをかざしてください）');
    }, 800);
  }

  function ensureReaderContainer(){
    const container = document.querySelector('.scanner-container');
    if (!container) return null;
    let reader = document.getElementById('barcodeReader');
    if (!reader){
      reader = document.createElement('div');
      reader.id = 'barcodeReader';
      reader.style.maxWidth = '640px';
      reader.style.margin = '0 auto';
      reader.style.borderRadius = '8px';
      reader.style.overflow = 'hidden';
      container.insertBefore(reader, container.firstChild);
    }
    return reader;
  }

  function ensureCameraControlsUI(){
    const controls = document.querySelector('.camera-controls');
    if (!controls) return null;

    let select = document.getElementById('cameraSelect');
    if (!select){
      select = document.createElement('select');
      select.id = 'cameraSelect';
      select.className = 'btn';
      select.style.marginLeft = '8px';
      select.ariaLabel = 'カメラ選択';
      controls.appendChild(select);
      select.addEventListener('change', async ()=>{
        const id = select.value;
        if (!id || id === currentDeviceId) return;
        await switchCameraTo(id);
      });
    }

    let btn = document.getElementById('switchCameraBtn');
    if (!btn){
      btn = document.createElement('button');
      btn.id = 'switchCameraBtn';
      btn.className = 'btn btn-secondary';
      btn.textContent = '🔄 カメラ切替';
      btn.style.marginLeft = '8px';
      controls.appendChild(btn);
      btn.addEventListener('click', async ()=>{
        const sel = document.getElementById('cameraSelect');
        if (!sel || sel.options.length < 2) return;
        const idx = sel.selectedIndex;
        const nextIdx = (idx + 1) % sel.options.length;
        const nextId = sel.options[nextIdx].value;
        sel.selectedIndex = nextIdx;
        await switchCameraTo(nextId);
      });
    }
    
    // 統計表示エリア
    let stats = document.getElementById('scanStats');
    if (!stats){
      stats = document.createElement('div');
      stats.id = 'scanStats';
      stats.style.marginTop = '8px';
      stats.style.fontSize = '0.9em';
      stats.style.color = '#666';
      controls.appendChild(stats);
    }
    
    return select;
  }

  async function getVideoInputs(){
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some(d => d.kind === 'videoinput' && d.label)){
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach(t=>t.stop());
      } catch(_) {}
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    return devices.filter(d => d.kind === 'videoinput');
  }

  function pickBackCameraId(videoInputs){
    // 背面カメラを優先的に選択（複数のパターンに対応）
    const back = videoInputs.find(d => {
      const label = (d.label || '').toLowerCase();
      return label.includes('back') || 
             label.includes('rear') || 
             label.includes('environment') ||
             label.includes('背面') ||
             label.includes('外側');
    });
    
    // 見つからなければ最後のカメラ（多くの場合背面）
    return back ? back.deviceId : (videoInputs.length > 1 ? videoInputs[videoInputs.length - 1].deviceId : videoInputs[0]?.deviceId);
  }

  function populateCameraSelect(options){
    const select = ensureCameraControlsUI();
    if (!select) return;
    while (select.firstChild) select.removeChild(select.firstChild);
    options.forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      // ラベルをわかりやすく
      let displayLabel = label || id;
      if (/back|rear|environment|背面|外側/i.test(label)) {
        displayLabel = '📷 背面カメラ: ' + label;
      } else if (/front|user|face|前面|内側/i.test(label)) {
        displayLabel = '🤳 前面カメラ: ' + label;
      }
      opt.textContent = displayLabel;
      select.appendChild(opt);
    });
    if (currentDeviceId){
      const idx = options.findIndex(o => o.id === currentDeviceId);
      if (idx >= 0) select.selectedIndex = idx;
    }
  }

  async function loadExternalScript(url){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Script load failed: ' + url));
      document.head.appendChild(s);
    });
  }

  async function listVideoInputsZXing(){
    try {
      const devs1 = await ZXing.BrowserCodeReader.listVideoInputDevices();
      if (devs1 && devs1.some(d => d.label)) return devs1;
    } catch(_) {}
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      tmp.getTracks().forEach(t=>t.stop());
    } catch(_) {}
    try {
      return await ZXing.BrowserCodeReader.listVideoInputDevices();
    } catch(_) {
      return [];
    }
  }

  // ZXing スキャナ開始（背面カメラ優先、高解像度設定）
  async function startZXingScanner(deviceId){
    const video = document.getElementById('cameraPreview');
    if (!video) return;
    video.style.display = 'block';

    const hints = new Map();
    const formats = [
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.CODE_93,
      ZXing.BarcodeFormat.ITF // 物流用バーコードにも対応
    ];
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true); // 精度向上

    if (codeReader) {
      try { codeReader.reset(); } catch(_) {}
      codeReader = null;
    }
    codeReader = new ZXing.BrowserMultiFormatReader(hints);

    currentScannerType = 'zxing';
    currentDeviceId = deviceId || null;

    const startBtn = $('startCameraBtn');
    const captureBtn = $('captureBtn');
    const stopBtn = $('stopCameraBtn');
    if (startBtn) startBtn.style.display = 'none';
    if (captureBtn) captureBtn.style.display = 'none'; // ZXingは連続スキャンなので不要
    if (stopBtn) stopBtn.style.display = 'inline-block';

    running = true;
    setText('ocrProgress', '📷 背面カメラ起動中...');

    // 高解像度設定
    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        focusMode: 'continuous', // オートフォーカス
        facingMode: deviceId ? undefined : 'environment' // 背面カメラ優先
      }
    };

    await codeReader.decodeFromConstraints(constraints, 'cameraPreview', async (result, err) => {
      if (!running) return;
      if (result) {
        const text = result.getText ? result.getText() : (result.text || '');
        if (text) {
          setText('ocrResult', `✅ 読取: ${text}`);
          try { await handleDecoded(text); } catch(e) { console.error(e); }
        }
      }
    });
    
    setText('ocrProgress', '📷 スキャン待機中（バーコードをカメラに向けてください）');
  }

  // QuaggaJS 改良版
  async function ensureQuaggaLoaded(){
    if (window.Quagga) return;
    try { await loadExternalScript('https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js'); } catch(_){}
    if (!window.Quagga) throw new Error('QuaggaJSの読み込みに失敗しました');
  }

  async function startQuaggaScanner(deviceId){
    await ensureQuaggaLoaded();
    const container = ensureReaderContainer();
    if (!container){ showActionResult('エラー', '<p>スキャナーの初期化に失敗しました。</p>', 'error'); return; }

    const inputs = await getVideoInputs();
    const mapped = inputs.map(d => ({ id: d.deviceId, label: d.label || d.deviceId }));
    if (mapped.length) populateCameraSelect(mapped);

    let backId = deviceId || pickBackCameraId(inputs);

    const constraints = backId
      ? { deviceId: { exact: backId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };

    const config = {
      inputStream: {
        type: 'LiveStream',
        target: container,
        constraints,
        area: { top: "20%", right: "10%", left: "10%", bottom: "20%" } // スキャン範囲を絞る
      },
      decoder: {
        readers: [ 
          'ean_reader', 
          'ean_8_reader', 
          'code_128_reader', 
          'code_39_reader',
          'code_93_reader',
          'i2of5_reader' // Interleaved 2 of 5
        ],
        multiple: false // 1つずつ確実にスキャン
      },
      locate: true,
      locator: {
        patchSize: "medium",
        halfSample: false // 高精度モード
      },
      numOfWorkers: Math.min(4, navigator.hardwareConcurrency || 2),
      frequency: 10 // スキャン頻度（fps）
    };

    await new Promise((resolve, reject)=>{
      Quagga.init(config, (err)=>{
        if (err) { reject(err); return; }
        Quagga.start();
        resolve();
      });
    });

    currentScannerType = 'quagga';
    currentDeviceId = backId || null;

    const startBtn = $('startCameraBtn');
    const captureBtn = $('captureBtn');
    const stopBtn = $('stopCameraBtn');
    if (startBtn) startBtn.style.display = 'none';
    if (captureBtn) captureBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-block';

    running = true;
    setText('ocrProgress', '📷 スキャン待機中（バーコードをカメラに向けてください）');

    // 検出精度を上げるため、連続して同じコードが検出された場合のみ処理
    let consecutiveDetections = new Map(); // code -> count
    
    Quagga.onDetected(async (data)=>{
      if (!running) return;
      try {
        const code = data?.codeResult?.code || '';
        if (!code) return;
        
        // 検出品質チェック（エラー率が低いものだけ採用）
        const errors = data?.codeResult?.decodedCodes?.filter(d => d.error).length || 0;
        const total = data?.codeResult?.decodedCodes?.length || 1;
        const errorRate = errors / total;
        
        if (errorRate > 0.3) return; // エラー率30%以上は無視
        
        // 連続検出カウント
        const count = (consecutiveDetections.get(code) || 0) + 1;
        consecutiveDetections.set(code, count);
        
        // 同じコードが2回連続で検出されたら処理（誤検出防止）
        if (count >= 2 && code !== lastIsbn) {
          consecutiveDetections.clear();
          setText('ocrResult', `✅ 読取: ${code}`);
          await handleDecoded(code);
        }
        
        // 古いカウントをクリア
        if (consecutiveDetections.size > 10) {
          consecutiveDetections.clear();
        }
      } catch (e) { console.error(e); }
    });
  }

  async function stopQuaggaScanner(){
    try {
      if (window.Quagga){
        try { Quagga.offDetected(); } catch(_){}
        try { Quagga.stop(); } catch(_){}
      }
      if (window.__canvasObserver) {
        window.__canvasObserver.disconnect();
        window.__canvasObserver = null;
      }
    } catch(_) {}
  }

  async function switchCameraTo(deviceId){
    if (!deviceId) return;
    setText('ocrProgress', '🔄 カメラ切替中...');
    try {
      if (currentScannerType === 'zxing'){
        running = false;
        if (codeReader) { try { codeReader.reset(); } catch(_) {} }
        await new Promise(r => setTimeout(r, 300)); // 少し待機
        await startZXingScanner(deviceId);
      } else if (currentScannerType === 'quagga'){
        await stopQuaggaScanner();
        await new Promise(r => setTimeout(r, 300));
        await startQuaggaScanner(deviceId);
      } else {
        await startQuaggaScanner(deviceId);
      }
      setText('ocrProgress', '✅ カメラを切り替えました');
      playBeep(true);
    } catch (e) {
      console.error(e);
      setText('ocrProgress', '❌ カメラ切替に失敗しました');
      playBeep(false);
    }
  }

  // カメラ開始（ZXing優先、背面カメラ自動選択）
  async function startCamera(){
    if (running) return;

    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure){ 
      setText('ocrProgress', '❌ カメラはHTTPSまたはlocalhostでのみ使用できます'); 
      return; 
    }

    setText('ocrProgress', '📷 カメラを起動しています...');
    
    // 統計リセット
    scanCount = 0;
    successCount = 0;
    updateScanStats();

    try {
      ensureReaderContainer();
      ensureCameraControlsUI();

      const inputs = await listVideoInputsZXing();
      if (!inputs || inputs.length === 0){
        setText('ocrProgress', 'ZXing失敗。Quaggaで起動を試します...');
        await startQuaggaScanner();
        return;
      }
      
      const mapped = inputs.map(d => ({ id: d.deviceId, label: d.label || d.deviceId }));
      
      // 背面カメラを自動選択
      const backCamera = mapped.find(c => 
        /back|rear|environment|背面|外側/i.test(c.label)
      );
      
      const selectedCamera = backCamera || mapped[mapped.length - 1]; // 背面優先、なければ最後のカメラ
      
      populateCameraSelect(mapped);
      
      setText('ocrProgress', `📷 ${selectedCamera.label} を起動中...`);
      await startZXingScanner(selectedCamera.id);
      
    } catch (e) {
      console.error(e);
      try {
        setText('ocrProgress', 'ZXing起動失敗。Quaggaで再試行中...');
        await startQuaggaScanner();
      } catch (qerr) {
        const msg = String(qerr?.message || e?.message || '不明なエラー');
        if (/NotAllowedError|Permission/i.test(msg)) {
          setText('ocrProgress', '❌ カメラへのアクセスが拒否されました。ブラウザの設定で許可してください');
        } else if (/NotFoundError|Overconstrained/i.test(msg)) {
          setText('ocrProgress', '❌ カメラが見つかりません。デバイスを確認してください');
        } else {
          setText('ocrProgress', `❌ カメラ起動失敗: ${msg}`);
        }
        playBeep(false);
      }
    }
  }

  async function stopCamera(){
    try {
      running = false;
      if (codeReader) {
        try { codeReader.reset(); } catch(_) {}
        codeReader = null;
      }
      await stopQuaggaScanner();
    } catch(_) {}

    const video = document.getElementById('cameraPreview');
    if (video) {
      try { video.pause(); video.srcObject = null; } catch(_) {}
      video.style.display = 'none';
    }

    const reader = document.getElementById('barcodeReader');
    if (reader && reader.parentNode) reader.parentNode.removeChild(reader);

    lastIsbn = '';
    lastScanTime = 0;
    currentDeviceId = null;
    currentScannerType = null;

    const startBtn = $('startCameraBtn');
    const captureBtn = $('captureBtn');
    const stopBtn = $('stopCameraBtn');
    if (startBtn) startBtn.style.display = 'inline-block';
    if (captureBtn) captureBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';

    setText('ocrProgress', '⏸️ カメラを停止しました');
  }

  window.startCamera = startCamera;
  window.stopCamera = stopCamera;
  window.captureAndScan = function(){ setText('ocrProgress', '📷 連続スキャン中...'); };
})();