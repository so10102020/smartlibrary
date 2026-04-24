(function(){
  'use strict';
  
  let running = false;
  let lastScannedCode = '';
  let lastScanTime = 0;
  let scanCount = 0;
  let successCount = 0;
  
  const $ = (id) => document.getElementById(id);
  const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  
  // ビープ音
  function playBeep(success = true){
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.value = success ? 1200 : 400;
      oscillator.type = 'sine';
      
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch(e) {}
  }
  
  // バイブレーション
  function vibrate(pattern = [50]){
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch(e) {}
  }
  
  // 統計更新
  function updateStats(){
    const statsEl = $('adminScanStats');
    if (statsEl) {
      const rate = scanCount > 0 ? Math.round(successCount/scanCount*100) : 0;
      statsEl.innerHTML = `📊 スキャン: ${scanCount}回 | 成功: ${successCount}回 | 成功率: ${rate}%`;
    }
  }
  
  // ISBN抽出
  function extractIsbn13(raw){
    if (!raw) return '';
    let text = String(raw).replace(/^\s*ISBN(?:-1[03])?:?\s*/i, '').replace(/[-\s]/g, '');
    let m13 = text.match(/\b(97[89]\d{10})\b/) || String(raw).match(/\b(97[89]\d{10})\b/);
    if (m13) return m13[1];
    
    // ISBN-10を13に変換
    let m10 = text.match(/\b(\d{9}[\dXx])\b/) || String(raw).match(/\b(\d{9}[\dXx])\b/);
    if (m10) {
      const digits = m10[1].replace(/[^0-9Xx]/g, '');
      if (digits.length === 10) {
        const core = '978' + digits.substring(0,9);
        let sum = 0;
        for (let i=0; i<core.length; i++){
          const n = parseInt(core[i], 10);
          sum += (i % 2 === 0) ? n : n*3;
        }
        const cd = (10 - (sum % 10)) % 10;
        return core + String(cd);
      }
    }
    
    const digits = String(raw).replace(/[^0-9Xx]/g, '');
    if (digits.length === 13 && /^97[89]/.test(digits)) return digits;
    return '';
  }
  
  // スキャン結果処理
  async function handleScanned(code){
    const now = Date.now();
    const isbn13 = extractIsbn13(code);
    
    // 500ms以内の重複スキャンを無視
    if (code === lastScannedCode && (now - lastScanTime) < 500) return;
    
    lastScannedCode = code;
    lastScanTime = now;
    scanCount++;
    
    setText('adminScanResult', `📖 読取: ${isbn13 || code}`);
    
    if (!isbn13) {
      setText('adminScanStatus', '❌ 有効なISBNではありません');
      playBeep(false);
      vibrate([100, 50, 100]);
      successCount--;
      if (successCount < 0) successCount = 0;
      updateStats();
      return;
    }
    
    // クイック登録モード: キューに追加
    if (window.addToQuickQueue) {
      window.addToQuickQueue(isbn13);
      setText('adminScanStatus', '✅ キューに追加しました');
      playBeep(true);
      vibrate([50]);
      successCount++;
      updateStats();
      
      // 1秒後に次のスキャン準備
      setTimeout(() => {
        setText('adminScanStatus', '📷 次のバーコードをスキャンしてください');
      }, 1000);
    }
  }
  
  // Quaggaローダー
  async function loadQuagga(){
    if (window.Quagga) return;
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Quaggaの読み込みに失敗しました'));
      document.head.appendChild(script);
    });
  }
  
  // カメラデバイス取得
  async function getVideoInputs(){
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some(d => d.kind === 'videoinput' && d.label)){
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach(t => t.stop());
      } catch(_) {}
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    return devices.filter(d => d.kind === 'videoinput');
  }
  
  // 背面カメラ選択
  function pickBackCamera(devices){
    const back = devices.find(d => {
      const label = (d.label || '').toLowerCase();
      return label.includes('back') || 
             label.includes('rear') || 
             label.includes('environment') ||
             label.includes('背面') ||
             label.includes('外側');
    });
    return back ? back.deviceId : (devices.length > 1 ? devices[devices.length - 1].deviceId : devices[0]?.deviceId);
  }
  
  // カメラ選択UI更新
  function updateCameraSelect(devices){
    const select = $('adminCameraSelect');
    if (!select) return;
    
    select.innerHTML = '';
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      let label = d.label || d.deviceId;
      if (/back|rear|environment|背面|外側/i.test(d.label)) {
        label = '📷 背面: ' + label;
      } else if (/front|user|face|前面|内側/i.test(d.label)) {
        label = '🤳 前面: ' + label;
      }
      opt.textContent = label;
      select.appendChild(opt);
    });
  }
  
  // スキャナー開始
  async function startAdminScanner(){
    if (running) return;
    
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure){
      setText('adminScanStatus', '❌ HTTPSまたはlocalhostが必要です');
      return;
    }
    
    setText('adminScanStatus', '📷 カメラを起動しています...');
    
    try {
      await loadQuagga();
      
      const devices = await getVideoInputs();
      if (!devices.length) {
        setText('adminScanStatus', '❌ カメラが見つかりません');
        return;
      }
      
      updateCameraSelect(devices);
      const backCameraId = pickBackCamera(devices);
      
      const container = $('adminScannerContainer');
      if (!container) {
        setText('adminScanStatus', '❌ スキャナーコンテナが見つかりません');
        return;
      }
      
      const constraints = backCameraId
        ? { deviceId: { exact: backCameraId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };
      
      const config = {
        inputStream: {
          type: 'LiveStream',
          target: container,
          constraints,
          area: { top: "15%", right: "10%", left: "10%", bottom: "15%" }
        },
        decoder: {
          readers: [ 
            'ean_reader', 
            'ean_8_reader', 
            'code_128_reader', 
            'code_39_reader',
            'code_93_reader'
          ],
          multiple: false
        },
        locate: true,
        locator: {
          patchSize: "medium",
          halfSample: false
        },
        numOfWorkers: Math.min(4, navigator.hardwareConcurrency || 2),
        frequency: 10
      };
      
      await new Promise((resolve, reject) => {
        Quagga.init(config, (err) => {
          if (err) {
            reject(err);
            return;
          }
          Quagga.start();
          resolve();
        });
      });
      
      running = true;
      scanCount = 0;
      successCount = 0;
      updateStats();
      
      $('adminStartBtn').style.display = 'none';
      $('adminStopBtn').style.display = 'inline-block';
      
      setText('adminScanStatus', '✅ スキャン待機中（バーコードをカメラに向けてください）');
      
      // 検出精度向上: 連続2回検出で確定
      let consecutiveDetections = new Map();
      
      Quagga.onDetected(async (data) => {
        if (!running) return;
        
        try {
          const code = data?.codeResult?.code || '';
          if (!code) return;
          
          // 品質チェック
          const errors = data?.codeResult?.decodedCodes?.filter(d => d.error).length || 0;
          const total = data?.codeResult?.decodedCodes?.length || 1;
          const errorRate = errors / total;
          
          if (errorRate > 0.3) return;
          
          // 連続検出カウント
          const count = (consecutiveDetections.get(code) || 0) + 1;
          consecutiveDetections.set(code, count);
          
          // 2回連続検出で処理
          if (count >= 2 && code !== lastScannedCode) {
            consecutiveDetections.clear();
            await handleScanned(code);
          }
          
          // 古いカウントをクリア
          if (consecutiveDetections.size > 10) {
            consecutiveDetections.clear();
          }
        } catch (e) {
          console.error('Scan error:', e);
        }
      });
      
      playBeep(true);
      
    } catch (e) {
      console.error('Scanner start error:', e);
      const msg = String(e?.message || e);
      if (/NotAllowedError|Permission/i.test(msg)) {
        setText('adminScanStatus', '❌ カメラアクセスが拒否されました。ブラウザ設定で許可してください');
      } else if (/NotFoundError/i.test(msg)) {
        setText('adminScanStatus', '❌ カメラが見つかりません');
      } else {
        setText('adminScanStatus', `❌ エラー: ${msg}`);
      }
      playBeep(false);
    }
  }
  
  // スキャナー停止
  async function stopAdminScanner(){
    try {
      running = false;
      
      if (window.Quagga){
        try { Quagga.offDetected(); } catch(_){}
        try { Quagga.stop(); } catch(_){}
      }
      
      const container = $('adminScannerContainer');
      if (container) container.innerHTML = '';
      
      $('adminStartBtn').style.display = 'inline-block';
      $('adminStopBtn').style.display = 'none';
      
      setText('adminScanStatus', '⏸️ カメラを停止しました');
      
      lastScannedCode = '';
      lastScanTime = 0;
      
    } catch (e) {
      console.error('Stop scanner error:', e);
    }
  }
  
  // カメラ切替
  async function switchAdminCamera(){
    const select = $('adminCameraSelect');
    if (!select || !running) return;
    
    const deviceId = select.value;
    if (!deviceId) return;
    
    setText('adminScanStatus', '🔄 カメラを切り替えています...');
    await stopAdminScanner();
    await new Promise(r => setTimeout(r, 500));
    await startAdminScanner();
  }
  
  // 公開
  window.startAdminScanner = startAdminScanner;
  window.stopAdminScanner = stopAdminScanner;
  window.switchAdminCamera = switchAdminCamera;
  
})();
