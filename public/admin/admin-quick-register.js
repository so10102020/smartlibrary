// ===== ⚡ クイック登録機能 =====
(function(){
  'use strict';
  
  let quickQueue = [];

  function importQueueFromScanner() {
    const raw = sessionStorage.getItem('adminScanQueue');
    if (!raw) return;

    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;

      let added = 0;
      for (const code of list) {
        const isbn13 = window.extractIsbn13(code);
        if (!isbn13) continue;
        const exists = quickQueue.find(q => q.isbn === isbn13);
        if (exists) continue;
        quickQueue.push({ isbn: isbn13, status: 'pending' });
        added++;
      }

      if (added > 0) {
        window.showActionResult('スキャン取込完了', `${added}件をキューに追加しました`, 'success');
      }
    } catch (error) {
      console.warn('adminScanQueue parse error:', error);
    } finally {
      sessionStorage.removeItem('adminScanQueue');
      sessionStorage.removeItem('quickScanMode');
    }
  }
  
  window.initQuickRegister = function() {
    console.log('⚡ クイック登録初期化');
    importQueueFromScanner();
    renderQuickQueue();
  };
  
  window.startQuickScan = function() {
    sessionStorage.setItem('quickScanMode', 'true');
    window.location.href = 'admin-barcode-scanner.html?mode=quick';
  };
  
  window.showQuickManual = function() {
    const modal = window.$('quickManualModal');
    if (modal) {
      modal.style.display = 'flex';
      const input = window.$('quickIsbnInput');
      if (input) {
        input.value = '';
        input.focus();
      }
    }
  };
  
  window.closeQuickManual = function() {
    const modal = window.$('quickManualModal');
    if (modal) modal.style.display = 'none';
  };
  
  window.addQuickIsbnList = function() {
    const input = window.$('quickIsbnInput')?.value || '';
    const lines = input.split('\n').filter(l => l.trim());
    
    let added = 0;
    for (const line of lines) {
      const isbn = window.extractIsbn13(line.trim());
      if (!isbn) continue;
      
      const exists = quickQueue.find(q => q.isbn === isbn);
      if (exists) continue;
      
      quickQueue.push({ isbn, status: 'pending' });
      added++;
    }
    
    if (added > 0) {
      window.showActionResult('追加完了', `${added}件のISBNをキューに追加しました`, 'success');
      renderQuickQueue();
      window.closeQuickManual();
    } else {
      window.showActionResult('追加失敗', '有効なISBNが見つかりませんでした', 'error');
    }
  };
  
  function renderQuickQueue() {
    window.showElement('quickQueueSection', quickQueue.length > 0);
    
    const pending = quickQueue.filter(q => q.status === 'pending').length;
    const success = quickQueue.filter(q => q.status === 'success').length;
    const error = quickQueue.filter(q => q.status === 'error').length;
    
    window.setText('queuePending', pending);
    window.setText('queueSuccess', success);
    window.setText('queueError', error);
    
    const container = window.$('quickQueueList');
    if (!container) return;
    
    if (quickQueue.length === 0) {
      container.innerHTML = '<p style="color:#999;">キューが空です</p>';
      return;
    }
    
    let html = '<div class="queue-items">';
    quickQueue.forEach((item, idx) => {
      const statusIcon = item.status === 'success' ? '✅' : 
                        item.status === 'error' ? '❌' : '⏳';
      const statusClass = `queue-item ${item.status}`;
      const message = item.message ? `<small>${window.escapeHtml(item.message)}</small>` : '';
      
      html += `
        <div class="${statusClass}">
          <span class="queue-icon">${statusIcon}</span>
          <span class="queue-isbn">${window.escapeHtml(item.isbn)}</span>
          ${message}
          ${item.status === 'pending' ? 
            `<button class="btn-icon" onclick="removeFromQueue(${idx})" title="削除">🗑️</button>` : ''}
        </div>
      `;
    });
    html += '</div>';
    
    container.innerHTML = html;
  }
  
  window.removeFromQueue = function(index) {
    quickQueue.splice(index, 1);
    renderQuickQueue();
  };
  
  window.processQuickQueue = async function() {
    const pending = quickQueue.filter(q => q.status === 'pending');
    if (pending.length === 0) {
      window.showActionResult('完了', 'すべて処理済みです', 'info');
      return;
    }
    
    const btn = window.$('processQueueBtn');
    if (btn) btn.disabled = true;
    
    window.showActionResult('処理中', `${pending.length}件を登録中...`, 'processing');
    
    for (const item of pending) {
      try {
        await registerBookLight({ isbn13: item.isbn, stock_count: 1 });
        item.status = 'success';
        item.message = '登録完了';
      } catch (e) {
        item.status = 'error';
        item.message = e.message || '登録失敗';
      }
      renderQuickQueue();
      await new Promise(r => setTimeout(r, 100));
    }
    
    if (btn) btn.disabled = false;
    
    const finalSuccess = quickQueue.filter(q => q.status === 'success').length;
    const finalError = quickQueue.filter(q => q.status === 'error').length;
    
    window.showActionResult(
      '一括登録完了',
      `成功: ${finalSuccess}件 / 失敗: ${finalError}件`,
      finalError > 0 ? 'warning' : 'success'
    );
  };
  
  window.clearQuickQueue = function() {
    if (quickQueue.length === 0) return;
    if (!confirm('キューをクリアしますか？')) return;
    quickQueue = [];
    renderQuickQueue();
  };
  
  // 軽量登録（ISBNと在庫数のみ）
  async function registerBookLight(bookData) {
    const db = window.adminState.db;
    const user = window.adminState.auth.currentUser;
    
    if (!user || !window.adminState.isAuthenticated) {
      throw new Error('管理者権限が必要です');
    }
    
    const isbn13 = bookData.isbn13 || window.extractIsbn13(bookData.isbn || '');
    if (!isbn13) throw new Error('有効なISBNが必要です');
    
    // 重複チェック
    const existing = await db.collection('books')
      .where('isbn13', '==', isbn13)
      .limit(1)
      .get();
    
    if (!existing.empty) {
      const doc = existing.docs[0];
      const current = doc.data();
      await doc.ref.update({
        stock_count: (current.stock_count || 0) + bookData.stock_count,
        available_count: (current.available_count || 0) + bookData.stock_count,
        updated_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { id: doc.id, updated: true };
    }
    
    // 新規登録（軽量版）
    const docRef = db.collection('books').doc();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    
    const lightDoc = {
      book_id: docRef.id,
      isbn13: isbn13,
      isbn: isbn13,
      title: `ISBN:${isbn13}`,
      authors: '',
      publisher: '',
      published: '',
      pages: null,
      price: null,
      stock_count: parseInt(bookData.stock_count) || 1,
      available_count: parseInt(bookData.stock_count) || 1,
      status: '在架',
      notes: '',
      isbn_digits: window.onlyDigits(isbn13),
      search_blob: window.normalizeForSearch(isbn13),
      metadata_loaded: false,
      created_at: now,
      updated_at: now,
      created_by: user.uid
    };
    
    await docRef.set(lightDoc);
    return { id: docRef.id, data: lightDoc };
  }
  
  // バーコードスキャナーからのコールバック
  window.addToQuickQueue = function(isbn) {
    const isbn13 = window.extractIsbn13(isbn);
    if (!isbn13) return;
    
    const exists = quickQueue.find(q => q.isbn === isbn13);
    if (exists) return;
    
    quickQueue.push({ isbn: isbn13, status: 'pending' });
    renderQuickQueue();
    
    // 音声フィードバック（オプション）
    if (window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance('追加');
      utterance.rate = 2;
      utterance.volume = 0.3;
      window.speechSynthesis.speak(utterance);
    }
  };
  
  console.log('✅ admin-quick-register.js loaded');
})();
