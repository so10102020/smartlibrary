// ===== 蔵書管理（検索・編集・削除）- 無限スクロール対応版 =====
(function(){
  'use strict';
  
  let booksCache = [];
  let lastVisible = null;
  let isLoading = false;
  let hasMore = true;
  let currentSearchTerm = '';
  let currentStatusFilter = '';
  const BATCH_SIZE = 100;
  
  window.initBooksManagement = async function() {
    await searchBooksManagement();
    setupInfiniteScroll();
  };
  
  window.searchBooksManagement = async function() {
    // 新しい検索の場合はリセット
    booksCache = [];
    lastVisible = null;
    hasMore = true;
    
    const container = window.$('booksTableContainer');
    if (container) container.innerHTML = '';
    
    await loadMoreBooks();
  };
  
  async function loadMoreBooks() {
    if (isLoading || !hasMore) return;
    
    isLoading = true;
    
    try {
      if (booksCache.length === 0) {
        window.showActionResult('処理中', '蔵書データ読み込み中...', 'processing');
      }
      
      currentSearchTerm = (window.$('booksSearchInput')?.value || '').trim().toLowerCase();
      currentStatusFilter = window.$('booksStatusFilter')?.value || '';
      const db = window.adminState.db;
      
      // クエリ構築
      let query = db.collection('books').orderBy('created_at', 'desc').limit(BATCH_SIZE);
      
      // ページネーション（前回の最後から続き）
      if (lastVisible) {
        query = query.startAfter(lastVisible);
      }
      
      const snap = await query.get();
      
      if (snap.empty) {
        hasMore = false;
        isLoading = false;
        
        if (booksCache.length === 0) {
          window.$('booksTableContainer').innerHTML = '<p>蔵書がありません</p>';
        } else {
          updateLoadMoreButton(false);
        }
        return;
      }
      
      // 最後のドキュメントを保存（次回のページネーション用）
      lastVisible = snap.docs[snap.docs.length - 1];
      
      // 新しいデータをキャッシュに追加
      const newBooks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      booksCache.push(...newBooks);
      
      // データが100件未満なら最後まで到達
      if (snap.docs.length < BATCH_SIZE) {
        hasMore = false;
      }
      
      // フィルタリング
      let filtered = booksCache;
      
      if (currentSearchTerm) {
        filtered = filtered.filter(b => {
          const text = [
            b.title, b.authors, b.author, b.isbn13, b.isbn, 
            b.publisher, b.call_number
          ].filter(Boolean).join(' ').toLowerCase();
          return text.includes(currentSearchTerm);
        });
      }
      
      if (currentStatusFilter) {
        filtered = filtered.filter(b => b.status === currentStatusFilter);
      }
      
      renderBooksTable(filtered);
      updateLoadMoreButton(hasMore);
      
      const resultSection = window.$('actionResultSection');
      if (resultSection) resultSection.style.display = 'none';
    } catch(e) {
      console.error(e);
      window.showActionResult('エラー', '蔵書一覧の読み込み失敗: ' + e.message, 'error');
    } finally {
      isLoading = false;
    }
  }
  
  function setupInfiniteScroll() {
    const container = window.$('booksTableContainer');
    if (!container) return;
    
    // スクロールイベント監視
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const scrollPosition = window.innerHeight + window.scrollY;
        const bottomThreshold = document.documentElement.scrollHeight - 300;
        
        if (scrollPosition >= bottomThreshold && hasMore && !isLoading) {
          loadMoreBooks();
        }
      }, 100);
    });
  }
  
  function updateLoadMoreButton(showButton) {
    let btn = window.$('loadMoreBooksBtn');
    
    if (!btn) {
      // ボタンが存在しない場合は作成
      btn = document.createElement('button');
      btn.id = 'loadMoreBooksBtn';
      btn.className = 'btn btn-primary';
      btn.style.cssText = 'display: block; margin: 20px auto; padding: 12px 24px;';
      btn.textContent = '続きを読み込む';
      btn.onclick = loadMoreBooks;
      
      const container = window.$('booksTableContainer');
      if (container && container.parentNode) {
        container.parentNode.insertBefore(btn, container.nextSibling);
      }
    }
    
    if (showButton) {
      btn.style.display = 'block';
      btn.disabled = isLoading;
      btn.textContent = isLoading ? '読み込み中...' : `続きを読み込む (現在${booksCache.length}件表示)`;
    } else {
      btn.style.display = 'none';
    }
  }
  
  function renderBooksTable(books) {
    const container = window.$('booksTableContainer');
    const summaryEl = window.$('booksSummary');
    if (!container) return;
    
    if (summaryEl) {
      const displayText = hasMore 
        ? `表示中: ${books.length}件 (さらに読み込み可能)`
        : `総件数: ${books.length}件`;
      summaryEl.textContent = displayText;
    }
    
    if (!books.length) {
      container.innerHTML = '<p>該当する蔵書はありません</p>';
      return;
    }
    
    const header = `
      <table class="preview-table">
        <thead>
          <tr>
            <th>タイトル</th>
            <th>著者</th>
            <th>ISBN</th>
            <th>在庫</th>
            <th>状態</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    const body = books.map(b => {
      const available = Number(b.available_count ?? 0);
      const stock = Number(b.stock_count ?? 0);
      const status = b.status || '在架';
      const statusClass = status === '貸出中' ? 'status-loaned' : 
                         status === '除籍' ? 'status-removed' : 'status-available';
      
      return `
        <tr>
          <td>${window.escapeHtml(b.title || '-')}</td>
          <td>${window.escapeHtml(b.authors || b.author || '-')}</td>
          <td><small>${window.escapeHtml(b.isbn13 || b.isbn || '-')}</small></td>
          <td>${available}/${stock}</td>
          <td><span class="status-badge ${statusClass}">${window.escapeHtml(status)}</span></td>
          <td>
            <button class="btn btn-sm" onclick="editBook('${b.id}')">編集</button>
            <button class="btn btn-sm btn-danger" onclick="deleteBook('${b.id}')">削除</button>
          </td>
        </tr>
      `;
    }).join('');
    
    container.innerHTML = header + body + '</tbody></table>';
  }
  
  window.editBook = async function(bookId) {
    const book = booksCache.find(b => b.id === bookId);
    if (!book) return;
    
    const newStock = prompt(`「${book.title}」の在庫数を変更\n現在: ${book.stock_count || 0}`, book.stock_count || 0);
    if (newStock === null) return;
    
    const stock = parseInt(newStock) || 0;
    try {
      const db = window.adminState.db;
      await db.collection('books').doc(bookId).update({
        stock_count: stock,
        available_count: Math.min(stock, Number(book.available_count ?? 0)),
        updated_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      window.showActionResult('更新完了', '在庫数を更新しました', 'success');
      await window.searchBooksManagement();
    } catch(e) {
      window.showActionResult('更新失敗', e.message, 'error');
    }
  };
  
  window.deleteBook = async function(bookId) {
    const book = booksCache.find(b => b.id === bookId);
    if (!book) return;
    
    if (!confirm(`「${book.title}」を削除しますか？`)) return;
    
    try {
      const db = window.adminState.db;
      
      // 貸出中チェック
      const loansSnap = await db.collection('loans')
        .where('book_id', '==', bookId)
        .where('status', '==', 'active')
        .limit(1)
        .get();
      
      if (!loansSnap.empty) {
        window.showActionResult('削除不可', '貸出中のため削除できません', 'error');
        return;
      }
      
      await db.collection('books').doc(bookId).delete();
      window.showActionResult('削除完了', '蔵書を削除しました', 'success');
      await window.searchBooksManagement();
    } catch(e) {
      window.showActionResult('削除失敗', e.message, 'error');
    }
  };
  
  window.exportBooksCsv = function() {
    if (!booksCache.length) {
      window.showActionResult('エラー', 'エクスポート対象がありません', 'error');
      return;
    }
    
    const rows = booksCache.map(b => ({
      タイトル: b.title || '',
      著者: b.authors || b.author || '',
      ISBN: b.isbn13 || b.isbn || '',
      出版社: b.publisher || '',
      在庫数: b.stock_count || 0,
      状態: b.status || ''
    }));
    
    const csv = window.Papa?.unparse ? Papa.unparse(rows) : 
      rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `books_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  // 🗑️ 全削除機能
  window.deleteAllBooks = async function() {
    if (!window.adminState.isAuthenticated) {
      alert('管理者権限が必要です');
      return;
    }
    
    const confirmText = prompt(
      '⚠️ 全ての本データを削除します\n' +
      '続行するには "DELETE ALL" と入力:'
    );
    
    if (confirmText !== 'DELETE ALL') {
      alert('キャンセルしました');
      return;
    }
    
    try {
      console.log('🔥 全削除開始...');
      window.showActionResult('処理中', '全削除中...', 'processing');
      
      const db = window.adminState.db;
      let deletedCount = 0;
      let hasMore = true;
      
      while (hasMore) {
        const snapshot = await db.collection('books').limit(500).get();
        if (snapshot.empty) {
          hasMore = false;
          break;
        }
        
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        
        deletedCount += snapshot.docs.length;
        console.log(`📊 ${deletedCount}件削除`);
        
        await new Promise(r => setTimeout(r, 500));
      }
      
      console.log(`✅ 完了: ${deletedCount}件削除`);
      window.showActionResult('削除完了', `${deletedCount}件削除しました`, 'success');
      
      booksCache = [];
      alert(`✅ ${deletedCount}件削除しました`);
      
    } catch (error) {
      console.error('❌ 削除エラー:', error);
      window.showActionResult('削除失敗', error.message, 'error');
    }
  };
  
  console.log('✅ admin-books-manage.js loaded (無限スクロール対応)');
})();
