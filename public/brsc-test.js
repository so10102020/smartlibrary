(function(){
  'use strict';
  const auth = () => firebase.auth();
  const db = () => firebase.firestore();

  let html5QrCode = null; // Html5Qrcode のインスタンス
  let running = false;
  let lastIsbn = '';

  // ネイティブバーコードスキャン用の状態
  let nativeStream = null;
  let rafId = null;

  let currentScannerType = null; // 'native' | 'html5' | 'zxing' | 'quagga'
  let currentDeviceId = null;
  let codeReader = null; // ZXing

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
  function normalizeIsbn(text){
    const raw = (text || '').replace(/[^0-9Xx]/g, '');
    if (raw.length === 13) return /^97[89]/.test(raw) ? raw : '';
    if (raw.length === 10) return toIsbn13(raw);
    return '';
  }

  // ISBN文字列の正規化（先頭の "ISBN-13:" などのプレフィックスやハイフンを除去して数字のみ抽出）
  function extractIsbn13(raw){
    if (!raw) return '';
    let text = String(raw).replace(/^\s*ISBN(?:-1[03])?:?\s*/i, '').replace(/[-\s]/g, '');
    // 13桁（978/979で開始）優先
    let m13 = text.match(/\b(97[89]\d{10})\b/) || String(raw).match(/\b(97[89]\d{10})\b/);
    if (m13) return m13[1];
    // ISBN-10 があれば13へ変換
    let m10 = text.match(/\b(\d{9}[\dXx])\b/) || String(raw).match(/\b(\d{9}[\dXx])\b/);
    if (m10) return toIsbn13(m10[1]);
    // フォールバック: 生テキストから数字のみ
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

  // 任意のスキャン結果から本を特定（ISBN→内部ID/バーコードの順に試行）
  async function getBookByAny(input){
    const raw = String(input || '').trim();
    const isbn13 = extractIsbn13(raw);
    if (isbn13){
      const byIsbn = await getBookByIsbn(isbn13);
      if (byIsbn) return { ...byIsbn, isbn13 };
    }

    // 内部コード（book_id/ドキュメントID/barcode）で探索
    const code = raw.replace(/\s+/g,'').replace(/^ISBN(?:-1[03])?:?/i,'');

    // 1) ドキュメントID一致
    try {
      const doc = await db().collection('books').doc(code).get();
      if (doc.exists) return { id: doc.id, data: doc.data(), isbn13: doc.data()?.isbn13 || null };
    } catch {}

    // 2) book_id フィールド一致
    let snap = await db().collection('books').where('book_id','==', code).limit(1).get();
    if (!snap.empty){ const d=snap.docs[0]; return { id:d.id, data:d.data(), isbn13: d.data()?.isbn13 || null }; }

    // 3) barcode フィールド一致（必要ならbooksにbarcodeを保存）
    snap = await db().collection('books').where('barcode','==', code).limit(1).get();
    if (!snap.empty){ const d=snap.docs[0]; return { id:d.id, data:d.data(), isbn13: d.data()?.isbn13 || null }; }

    return null;
  }

  // book_id（=booksドキュメントID）基準で貸出/返却する
  async function autoCheckoutOrReturnByBook(bookObj, meta){
    const user = auth().currentUser;
    if (!user){ showActionResult('ログインが必要です','<p>先にログインしてください。</p>','error'); return; }
    if (!bookObj){ showActionResult('未登録の資料','<p>この識別子の蔵書は登録されていません。</p>','warning'); return; }

    const { id: bookId, data: b, isbn13 } = bookObj;
    const bookRef = db().collection('books').doc(bookId);

    // 返却: ユーザーの未返却で book_id 一致を検索
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
        <p><strong>ID:</strong> ${escapeHtml(bookId)}</p>
        <p><strong>書名:</strong> ${escapeHtml(b?.title || '不明')}</p>
      `, 'success');
      return;
    }

    // 貸出
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
        <p><strong>ID:</strong> ${escapeHtml(bookObj.id)}</p>
        <p><strong>書名:</strong> ${escapeHtml(bookObj.data?.title || '不明')}</p>
      `, 'success');
    } catch (e) {
      showActionResult('貸出失敗', `<p>${escapeHtml(e.message || '処理に失敗しました')}</p>`, 'error');
    }
  }

  // HTMLエスケープ（< の置換バグ修正）
  function escapeHtml(str){
    return String(str ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  // スキャン結果の処理: ISBN優先→ダメなら内部コードで照合
  async function handleDecoded(text){
    const isbn13 = extractIsbn13(text);
    const meta = isbn13 ? await fetchIsbnMeta(isbn13).catch(()=>null) : null;

    let bookObj = null;
    if (isbn13) {
      const byIsbn = await getBookByIsbn(isbn13);
      if (byIsbn) bookObj = { ...byIsbn, isbn13 };
    }
    if (!bookObj) {
      bookObj = await getBookByAny(text);
    }

    if (!bookObj){ setText('ocrProgress', 'この識別子の蔵書は登録されていません。'); return; }

    const disp = isbn13 || String(text).replace(/^\s*ISBN(?:-1[03])?:?/i,'').replace(/[-\s]/g,'');
    if (disp === lastIsbn) return; // 重複抑制
    lastIsbn = disp;

    showSection('scanResultSection', true);
    setText('rawOcrText', disp);
    $('identifierSelection').innerHTML = '<div class="identifier-candidate selected">識別子を認識しました</div>';
    setText('ocrProgress', '処理中...');

    await autoCheckoutOrReturnByBook(bookObj, meta);
    setText('ocrProgress', '');
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
      reader.style.borderRadius = '8px';
      reader.style.overflow = 'hidden';
      container.insertBefore(reader, container.firstChild);
    }
    return reader;
  }

  // カメラ選択UIの生成/更新（既存デザイン内のcamera-controlsに追加）
  function ensureCameraControlsUI(){
    const controls = document.querySelector('.camera-controls');
    if (!controls) return null;

    let select = document.getElementById('cameraSelect');
    if (!select){
      select = document.createElement('select');
      select.id = 'cameraSelect';
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
      btn.textContent = 'カメラ切替';
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
    return select;
  }

  async function getVideoInputs(){
    // 権限がないとlabelが空のため、必要なら一度権限要求
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
    const back = videoInputs.find(d => /back|rear|environment/i.test(d.label)) || videoInputs[0];
    return back ? back.deviceId : null;
  }

  function populateCameraSelect(options){
    const select = ensureCameraControlsUI();
    if (!select) return;
    // 既存をクリア
    while (select.firstChild) select.removeChild(select.firstChild);
    options.forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = label || id;
      select.appendChild(opt);
    });
    // 現在選択を反映
    if (currentDeviceId){
      const idx = options.findIndex(o => o.id === currentDeviceId);
      if (idx >= 0) select.selectedIndex = idx;
    }
  }

  // 外部ライブラリ読込ユーティリティ
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

  // ZXing のデバイス列挙（label取得のための権限リフト込み）
  async function listVideoInputsZXing(){
    // 権限未付与時は label が空のことがあるため一度だけ権限を要求
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

  // ZXing スキャナ開始
  async function startZXingScanner(deviceId){
    const video = document.getElementById('cameraPreview');
    if (!video) return;
    video.style.display = 'block';

    // 対応フォーマットを絞る（EAN_13/EAN_8/Code128/Code39）
    const hints = new Map();
    const formats = [
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.CODE_39
    ];
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);

    // 既存を停止
    if (codeReader) {
      try { codeReader.reset(); } catch(_) {}
      codeReader = null;
    }
    codeReader = new ZXing.BrowserMultiFormatReader(hints);

    currentScannerType = 'zxing';
    currentDeviceId = deviceId || null;

    // ボタン表示切替
    const startBtn = $('startCameraBtn');
    const captureBtn = $('captureBtn');
    const stopBtn = $('stopCameraBtn');
    if (startBtn) startBtn.style.display = 'none';
    if (captureBtn) captureBtn.style.display = 'inline-block';
    if (stopBtn) stopBtn.style.display = 'inline-block';

    running = true;
    setText('ocrProgress', '外カメラ起動済み。バーコードを枠内に合わせてください。');

    await codeReader.decodeFromVideoDevice(deviceId || undefined, 'cameraPreview', async (result, err) => {
      if (!running) return;
      if (result) {
        const text = result.getText ? result.getText() : (result.text || '');
        if (text) {
          setText('ocrResult', `読み取り: ${text}`);
          try { await handleDecoded(text); } catch(e) { console.error(e); }
        }
      } else if (err && !(err instanceof ZXing.NotFoundException)) {
        // 連続デコード中の見つからないケース以外のエラー
        // console.warn(err);
      }
    });
  }

  // QuaggaJS ローダ
  async function ensureQuaggaLoaded(){
    if (window.Quagga) return;
    try { await loadExternalScript('vendor/quagga.min.js'); } catch(_){ /* ignore */ }
    if (window.Quagga) return;
    try { await loadExternalScript('https://unpkg.com/@ericblade/quagga2@1.2.6/dist/quagga.min.js'); } catch(_){ /* ignore */ }
    if (window.Quagga) return;
    await loadExternalScript('https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.2.6/dist/quagga.min.js');
    if (!window.Quagga) throw new Error('QuaggaJSの読み込みに失敗しました');
  }

  // QuaggaJS スキャナ開始（deviceId任意）
  async function startQuaggaScanner(deviceId){
    await ensureQuaggaLoaded();
    const container = ensureReaderContainer();
    if (!container){ showActionResult('エラー', '<p>スキャナーの初期化に失敗しました。</p>', 'error'); return; }

    // デバイス列挙してUI反映
    const inputs = await getVideoInputs();
    const mapped = inputs.map(d => ({ id: d.deviceId, label: d.label || d.deviceId }));
    if (mapped.length) populateCameraSelect(mapped);

    let backId = deviceId || pickBackCameraId(inputs);

    const constraints = backId
      ? { deviceId: backId, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } };

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
    if (captureBtn) captureBtn.style.display = 'inline-block';
    if (stopBtn) stopBtn.style.display = 'inline-block';

    running = true;
    setText('ocrProgress', '外カメラ起動済み。バーコードを枠内に合わせてください。');

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
        try { Quagga.offDetected(); } catch(_){}
        try { Quagga.stop(); } catch(_){}
      }
      // observer もクリーンアップ
      if (window.__canvasObserver) {
        window.__canvasObserver.disconnect();
        window.__canvasObserver = null;
      }
    } catch(_) {}
  }

  // カメラ切替（ZXing/Quagga対応）
  async function switchCameraTo(deviceId){
    if (!deviceId) return;
    setText('ocrProgress', 'カメラ切替中...');
    try {
      if (currentScannerType === 'zxing'){
        running = false;
        if (codeReader) { try { codeReader.reset(); } catch(_) {} }
        await startZXingScanner(deviceId);
      } else if (currentScannerType === 'quagga'){
        await stopQuaggaScanner();
        await startQuaggaScanner(deviceId);
      } else {
        // 未起動/他方式 -> Quaggaで起動してみる
        await startQuaggaScanner(deviceId);
      }
      setText('ocrProgress', 'カメラを切り替えました。');
    } catch (e) {
      console.error(e);
      setText('ocrProgress', 'カメラ切替に失敗しました。権限と接続を確認してください。');
    }
  }

  // カメラ開始（ZXing優先→Quaggaフォールバック）
  async function startCamera(){
    if (running) return;

    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure){ setText('ocrProgress', 'カメラはHTTPSまたはlocalhostでのみ使用できます。'); return; }

    setText('ocrProgress', 'カメラを起動しています...');

    try {
      // UI準備
      ensureReaderContainer();
      ensureCameraControlsUI();

      const inputs = await listVideoInputsZXing();
      if (!inputs || inputs.length === 0){
        setText('ocrProgress', 'ZXingの列挙に失敗。Quaggaで起動を試します...');
        await startQuaggaScanner();
        return;
      }
      const mapped = inputs.map(d => ({ id: d.deviceId, label: d.label || d.deviceId }));
      const back = mapped.find(c => /back|rear|environment/i.test(c.label)) || mapped[0];
      populateCameraSelect(mapped);
      await startZXingScanner(back.id);
    } catch (e) {
      console.error(e);
      // ZXingが失敗したらQuaggaへフォールバック
      try {
        setText('ocrProgress', 'ZXing起動に失敗。Quaggaで起動を試します...');
        await startQuaggaScanner();
      } catch (qerr) {
        const msg = String(qerr?.message || e?.message || '不明なエラー');
        if (/NotAllowedError|Permission/i.test(msg)) {
          setText('ocrProgress', 'カメラへのアクセスが許可されていません。サイトのカメラ権限を許可してください。');
        } else if (/NotFoundError|Overconstrained|no camera|could not start video source/i.test(msg)) {
          setText('ocrProgress', 'カメラが見つかりません。接続とブラウザ/OSの権限を確認してください。');
        } else {
          setText('ocrProgress', `カメラ起動に失敗しました: ${msg}`);
        }
      }
    }
  }

  // カメラ停止（ZXing）
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
      try { video.pause(); } catch(_) {}
      try { video.srcObject = null; } catch(_) {}
      video.style.display = 'none';
    }

    const reader = document.getElementById('barcodeReader');
    if (reader && reader.parentNode) reader.parentNode.removeChild(reader);

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

  // 公開関数をZXing版へ上書き
  window.startCamera = startCamera;
  window.stopCamera = stopCamera;
  window.captureAndScan = function(){ setText('ocrProgress', 'スキャン中です...'); };
})();