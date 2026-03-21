(function(){
  'use strict';
  const auth = () => firebase.auth();
  const db = () => firebase.firestore();

  let running = false;
  let lastIsbn = '';
  let currentScannerType = null; // 'quagga'
  let currentDeviceId = null;

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

  function escapeHtml(str){
    return String(str ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  async function handleDecoded(text){
    const isbn13 = extractIsbn13(text);

    // adminページ用ハンドラがある場合は委譲
    if (typeof handleBookScanResult === 'function') {
      await handleBookScanResult(isbn13 || text);
      return;
    }

    // 蔵書検索
    const meta = isbn13 ? await fetchIsbnMeta(isbn13).catch(()=>null) : null;
    let bookObj = null;
    if (isbn13) {
      const byIsbn = await getBookByIsbn(isbn13);
      if (byIsbn) bookObj = { ...byIsbn, isbn13 };
    }
    if (!bookObj) {
      bookObj = await getBookByAny(text);
    }

    const disp = isbn13 || String(text).replace(/^\s*ISBN(?:-1[03])?:?/i,'').replace(/[-\s]/g,'');
    if (!disp) return;
    if (disp === lastIsbn) return; // 重複抑制
    lastIsbn = disp;

    // UI更新（簡易表示）
    showSection('scanResultSection', true);
    setText('rawOcrText', disp);
    $('identifierSelection').innerHTML = '<div class="identifier-candidate selected">識別子を認識しました</div>';

    // 照合ができたらスキャナ停止し、circulation側へ結果を渡す
    try { await stopCamera(); } catch(_) {}
    if (typeof window.onScanBookFound === 'function') {
      window.onScanBookFound(bookObj, meta, disp);
    } else {
      // フォールバック表示
      if (!bookObj){
        showActionResult('未登録の資料', `<p>識別子: ${escapeHtml(disp)}</p><p>該当する蔵書が見つかりませんでした。</p>`, 'warning');
      } else {
        showActionResult('蔵書を検出', `<p>識別子: ${escapeHtml(disp)}</p><p>書名: ${escapeHtml(bookObj.data?.title || meta?.title || '不明')}</p>`, 'info');
      }
    }
  }

  function ensureReaderContainer(){
    const container = document.querySelector('.scanner-container');
    if (!container) return null;
    let reader = document.getElementById('barcodeReader');
    if (!reader){
      reader = document.createElement('div');
      reader.id = 'barcodeReader';
      reader.style.maxWidth = '480px';
      reader.style.margin = '0 auto';
      reader.style.padding = '0';
      reader.style.borderRadius = '8px';
      reader.style.overflow = 'hidden';
      reader.style.lineHeight = '0'; // 追加：テキスト由来の空白を除去
      container.insertBefore(reader, container.firstChild);
    }
    return reader;
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
    // より厳格な背面カメラ検索
    const backCamera = videoInputs.find(d => 
      /back|rear|environment|外側|背面|camera.*[2-9]|facing.*back/i.test(d.label)
    );
    
    // ラベルで見つからない場合は、deviceIdの順序で判定（通常最後のカメラが背面）
    if (!backCamera && videoInputs.length > 1) {
      return videoInputs[videoInputs.length - 1].deviceId;
    }
    
    return backCamera ? backCamera.deviceId : null;
  }

  // 外部ライブラリ読込
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

  async function ensureQuaggaLoaded(){
    if (window.Quagga) return;
    try { await loadExternalScript('vendor/quagga.min.js'); } catch(_){ /* ignore */ }
    if (window.Quagga) return;
    try { await loadExternalScript('https://unpkg.com/@ericblade/quagga2@1.2.6/dist/quagga.min.js'); } catch(_){ /* ignore */ }
    if (window.Quagga) return;
    await loadExternalScript('https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.2.6/dist/quagga.min.js');
    if (!window.Quagga) throw new Error('QuaggaJSの読み込みに失敗しました');
  }

    // Quagga スキャナ開始（背面カメラ専用）
  async function startQuaggaScanner(){
    await ensureQuaggaLoaded();
    const container = ensureReaderContainer();
    if (!container){ showActionResult('エラー', '<p>スキャナーの初期化に失敗しました。</p>', 'error'); return; }

    // 背面カメラを強制取得
    const inputs = await getVideoInputs();
    const backId = pickBackCameraId(inputs);
    
    // デバッグログ
    console.log('Available cameras:', inputs.map(d => ({ id: d.deviceId, label: d.label })));
    console.log('Selected back camera ID:', backId);

    // 背面カメラ優先設定を強化
    const constraints = {
      facingMode: { exact: 'environment' }, // まず environment を強制
      width: { ideal: 480 },
      height: { ideal: 640 }
    };
    
    // deviceIdがある場合はそれも併用
    if (backId) {
      constraints.deviceId = { exact: backId };
    }

    const config = {
      inputStream: {
        type: 'LiveStream',
        target: container,
        constraints
      },
      decoder: {
        readers: [ 'ean_reader', 'ean_8_reader', 'code_128_reader', 'code_39_reader' ]
      },
      locate: true,
      numOfWorkers: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2)))
    };

    await new Promise((resolve, reject)=>{
      Quagga.init(config, (err)=>{
        if (err) { 
          console.error('Quagga init error:', err);
          // facingMode: environment で失敗した場合の fallback
          if (backId) {
            const fallbackConfig = {
              ...config,
              inputStream: {
                type: 'LiveStream',
                target: container,
                constraints: {
                  deviceId: { exact: backId },
                  width: { ideal: 480 },
                  height: { ideal: 640 }
                }
              }
            };
            Quagga.init(fallbackConfig, (fallbackErr) => {
              if (fallbackErr) {
                reject(fallbackErr);
              } else {
                Quagga.start();
                resolve();
              }
            });
          } else {
            reject(err);
          }
          return;
        }
        Quagga.start();
      resolve();
    });
  });

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && node.classList?.contains('drawingBuffer')) {
          node.style.display = 'none';
        }
        // 子要素も確認
        if (node.querySelectorAll) {
          const canvases = node.querySelectorAll('canvas.drawingBuffer');
          canvases.forEach(canvas => canvas.style.display = 'none');
        }
      });
    });
  });

  observer.observe(container, { 
    childList: true, 
    subtree: true 
  });

  // クリーンアップ用に observer を保存
  window.__canvasObserver = observer;

    currentScannerType = 'quagga';
    currentDeviceId = backId || null;

    const startBtn = $('startCameraBtn');
    const captureBtn = $('captureBtn');
    const stopBtn = $('stopCameraBtn');
    if (startBtn) startBtn.style.display = 'none';
    if (captureBtn) captureBtn.style.display = 'inline-block';
    if (stopBtn) stopBtn.style.display = 'inline-block';

    running = true;
    setText('ocrProgress', '背面カメラ起動済み。バーコードを枠内に合わせてください。');

    Quagga.onDetected(async (data)=>{
      if (!running) return;
      try {
        const code = data?.codeResult?.code || '';
        if (!code) return;
        if (code === lastIsbn) return;
        setText('ocrResult', `読み取り: ${code}`);
        await handleDecoded(code);
      } catch (e) { console.error(e); }
    });
  }

  async function stopQuaggaScanner(){
    try {
      if (window.Quagga){
        try { Quagga.offDetected(); } catch(_) {}
        try { Quagga.stop(); } catch(_) {}
      }
      // observer もクリーンアップ
      if (window.__canvasObserver) {
        window.__canvasObserver.disconnect();
        window.__canvasObserver = null;
      }
    } catch(_) {}
  }

  // Public controls
  async function startCamera(){
    if (running) return;

    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure){ setText('ocrProgress', 'カメラはHTTPSまたはlocalhostでのみ使用できます。'); return; }

    setText('ocrProgress', '背面カメラを起動しています...');

    try {
      ensureReaderContainer();

      // 事前に1回権限要求してデバイス名を取得しやすくする
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            facingMode: { exact: 'environment' },
            width: { ideal: 480 },
            height: { ideal: 640 }
          } 
        });
        tmp.getTracks().forEach(t=>t.stop());
      } catch(_) {

        try {
          const tmp2 = await navigator.mediaDevices.getUserMedia({ video: true });
          tmp2.getTracks().forEach(t=>t.stop());
        } catch(_) {}
      }

      const inputs = await getVideoInputs();
      if (!inputs || inputs.length === 0){
        setText('ocrProgress', 'カメラが見つかりません。');
        return;
      }

      await startQuaggaScanner();
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e);
    if (/NotAllowedError|Permission/i.test(msg)) {
      setText('ocrProgress', 'カメラへのアクセスが許可されていません。サイトのカメラ権限を許可してください。');
    } else if (/NotFoundError|Overconstrained|no camera|could not start video source/i.test(msg)) {
      setText('ocrProgress', 'カメラが見つかりません。接続とブラウザ/OSの権限を確認してください。');
    } else {
      setText('ocrProgress', `カメラ起動に失敗しました: ${msg}`);
    }
  }
}

  async function stopCamera(){
    try { await stopQuaggaScanner(); } catch(_) {}

    const reader = document.getElementById('barcodeReader');
    if (reader && reader.parentNode) reader.parentNode.removeChild(reader);

    running = false;
    lastIsbn = '';
    currentDeviceId = null;
    currentScannerType = null;

    const startBtn = document.getElementById('startCameraBtn');
    const captureBtn = document.getElementById('captureBtn');
    const stopBtn = document.getElementById('stopCameraBtn');
    if (startBtn) startBtn.style.display = 'inline-block';
    if (captureBtn) captureBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';

    setText('ocrProgress', 'カメラを停止しました。');
  }

  // expose
  window.startCamera = startCamera;
  window.captureAndScan = function(){ setText('ocrProgress', 'スキャン中です...'); };
  window.stopCamera = stopCamera;
})();