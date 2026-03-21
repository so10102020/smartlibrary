// OPAC 検索ロジック（バニラJS + Firestore compat）
(function () {
  'use strict';

  // ユーティリティ: XSS対策
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- 検索用正規化ユーティリティ ---
  function toHalfWidth(str){
    return String(str || '')
      .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)) // 全角英数記号→半角
      .replace(/　/g, ' ');
  }
  function kataToHira(str){
    return String(str || '').replace(/[ァ-ン]/g, s => String.fromCharCode(s.charCodeAt(0) - 0x60));
  }
  function normalizeHyphen(str){
    return String(str || '').replace(/[‐‑‒–—―ー−]/g, '-');
  }
  function normalizeForSearch(str){
    let s = toHalfWidth(str).toLowerCase();
    s = normalizeHyphen(s);
    s = kataToHira(s);
    return s;
  }
  function onlyDigits(str){
    return String(str || '').replace(/[^0-9xX]/g, '');
  }

  // 同義語辞書（必要に応じて拡張可能）
  const SYNONYMS = {
    'github': ['ぎっとはぶ','ｷﾞｯﾄﾊﾌﾞ','ギットハブ','git hub','ぎっと はぶ','ｇｉｔｈｕｂ'],
    'git': ['ぎっと','ｷﾞｯﾄ','ギット','ｇｉｔ']
  };
  function expandTerms(raw){
    const t = normalizeForSearch(raw).trim();
    const parts = t.split(/\s+/).filter(Boolean);
    // 基本はAND検索: 各パートに同義語を展開
    const expanded = parts.map(p => {
      const bucket = new Set([p]);
      for (const key in SYNONYMS){
        const variants = SYNONYMS[key].map(v => normalizeForSearch(v));
        if (variants.includes(p)) bucket.add(key); // 同義語キーを追加
        // 入力がキーに近い場合（完全一致）も追加済み
        if (key === p) variants.forEach(v => bucket.add(v));
      }
      // ISBNっぽい（9桁以上の数字/ハイフン混在）ならdigitsも追加
      const dig = onlyDigits(p);
      if (dig.length >= 9) bucket.add(dig);
      return [...bucket];
    });
    return expanded; // 2次元配列: 各語の候補群
  }

  // 予約実行
  async function placeReservationInternal(bookId) {
    const user = firebase.auth().currentUser;
    if (!user) { alert('ログインが必要です'); return { ok:false, msg:'not-auth' }; }

    try {
      // 重複予約チェック（active のみ）
      const dup = await firebase.firestore().collection('reservations')
        .where('uid','==', user.uid)
        .where('book_id','==', bookId)
        .where('status','==','active')
        .limit(1)
        .get();
      if (!dup.empty) {
        return { ok:false, msg:'すでにこの本を予約済みです' };
      }

      // 予約を作成
      await firebase.firestore().collection('reservations').add({
        uid: user.uid,
        book_id: bookId,
        status: 'active',
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { ok:true };
    } catch (e) {
      console.error('予約エラー:', e);
      return { ok:false, msg: e.message || '予約に失敗しました' };
    }
  }

  // 詳細モーダル制御
  let currentDetailBookId = null;

  function openBookDetail(bookId){
    currentDetailBookId = bookId;
    const modal = document.getElementById('detailModal');
    const body = document.getElementById('detailBody');
    if (!modal || !body) return;

    // 初期表示
    body.innerHTML = '<p>読み込み中...</p>';
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    // 最新情報を取得
    firebase.firestore().collection('books').where('book_id','==', bookId).limit(1).get()
      .then(snap => {
        if (snap.empty) { body.innerHTML = '<p>蔵書が見つかりません。</p>'; return; }
        const data = snap.docs[0].data() || {};
        const available = Number(data.available_count ?? data.available_copies ?? 0);
        const stock = Number(data.stock_count ?? data.total_copies ?? 0);
        body.innerHTML = `
          <div class="book-card">
            ${data.thumbnail ? `<img src="${data.thumbnail}" class="book-thumbnail" alt="cover">` : ''}
            <div class="book-details">
              <h4>${escapeHtml(data.title || '無題')}</h4>
              <p><strong>蔵書ID:</strong> ${escapeHtml(bookId)}</p>
              <p><strong>ISBN:</strong> ${escapeHtml(data.isbn13 || data.isbn || '-')}</p>
              <p><strong>著者:</strong> ${escapeHtml(data.authors || data.author || '不明')}</p>
              <p><strong>出版社:</strong> ${escapeHtml(data.publisher || '-')}</p>
              <p><strong>在庫:</strong> 残り ${available} / 登録 ${stock}</p>
              ${data.description ? `<p style="margin-top:8px;">${escapeHtml(data.description)}</p>` : ''}
            </div>
          </div>
        `;
      })
      .catch(e => { body.innerHTML = `<p>読み込みに失敗しました: ${escapeHtml(e.message||'')}</p>`; });
  }

  function closeBookDetail(){
    const modal = document.getElementById('detailModal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    currentDetailBookId = null;
  }

  async function confirmReserveFromDetail(){
    if (!currentDetailBookId) return;
    if (!confirm('この本を予約しますか？')) return;
    const res = await placeReservationInternal(currentDetailBookId);
    if (res.ok) {
      alert('予約を受け付けました');
      closeBookDetail();
    } else {
      alert(res.msg || '予約に失敗しました');
    }
  }

  // 🔥 キャッシュ導入: 読み込み削減
  let booksCache = null;
  let cacheTimestamp = null;
  const CACHE_DURATION = 10 * 60 * 1000; // 🔥 10分間キャッシュ有効（5分→10分に延長）

  // 参照は DOM 解析後に取得
  document.addEventListener('DOMContentLoaded', () => {
    const resultsContainer = document.getElementById('resultsContainer');
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.querySelector('.search-btn-enhanced');

    function getTerm() {
      return (searchInput?.value || '').trim();
    }

    function renderMessage(message) {
      if (resultsContainer) {
        resultsContainer.innerHTML = `<div class="no-results-message"><p>${escapeHtml(message)}</p></div>`;
      }
    }

    function renderResults(items) {
      if (!Array.isArray(items) || items.length === 0) {
        renderMessage('該当する蔵書は見つかりませんでした。');
        return;
      }

      const html = items.map((item) => {
        const book = item.data;
        const bookId = book.book_id || item.id;
        const available = Number(book.available_copies ?? book.available_count ?? 0);
        const total = Number(book.total_copies ?? book.stock_count ?? 0);
        const stockClass = available > 0 ? 'stock--ok' : 'stock--out';
        return `
          <div class="result-card" data-book-id="${escapeHtml(bookId)}" onclick="openBookDetail('${escapeHtml(bookId)}')">
            <h3>${escapeHtml(book.title || '無題')}</h3>
            <p class="result-meta"><strong>著者:</strong> ${escapeHtml(book.author || book.authors || '不明')}</p>
            <p class="result-meta"><strong>ISBN:</strong> ${escapeHtml(book.isbn13 || book.isbn || '-')}</p>
            <p class="result-meta"><strong>蔵書ID:</strong> ${escapeHtml(bookId)}</p>
            <p class="result-meta"><strong>棚の位置:</strong> ${escapeHtml(book.location || book.current_location || '-')}</p>
            <p class="stock ${stockClass}"><strong>在庫:</strong> <strong>${available} / ${total}</strong></p>
            <div class="result-actions">
              <button type="button" class="reserve-chip" onclick="event.stopPropagation(); reserveFromCard('${escapeHtml(bookId)}')">予約</button>
            </div>
          </div>
        `;
      }).join('');

      resultsContainer.innerHTML = html;
    }

    async function searchBooksImpl(event) {
      // デフォルト動作を防ぐ
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      const termRaw = getTerm();
      const term = termRaw.trim();
      if (!term) {
        renderMessage('検索キーワードを入力してください。');
        return;
      }

      resultsContainer.innerHTML = '<div class="loading-indicator" style="display:block;"><div class="spinner"></div><p>検索中...</p></div>';

      try {
        // Firebaseが初期化されているか確認（待機処理を追加）
        let attempts = 0;
        while ((!window.firebase || !window.firebase.firestore) && attempts < 50) {
          await new Promise(r => setTimeout(r, 100));
          attempts++;
        }

        if (typeof firebase === 'undefined' || !firebase.firestore) {
          throw new Error('Firebaseが初期化されていません。ページを再読み込みしてください。');
        }

        // 🔥 キャッシュチェック
        const now = Date.now();
        if (booksCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
          console.log('📦 キャッシュから検索（読み込み0回）');
          const termVariantsByWord = expandTerms(term);
          performClientSideSearch(booksCache, termVariantsByWord);
          return;
        }

        // 🔥 limit付きクエリ（200件→100件に削減）
        console.log('🔥 Firebaseから読み込み中...');
        const snapshot = await firebase.firestore().collection('books')
          .limit(100)
          .get();

        console.log('✅ クエリ完了、ドキュメント数:', snapshot.size);

        // キャッシュ更新
        booksCache = [];
        snapshot.forEach((doc) => {
          booksCache.push({ id: doc.id, data: doc.data() || {} });
        });
        cacheTimestamp = now;
        console.log(`📚 Firebaseから${booksCache.length}件取得（キャッシュ10分間有効）`);

        console.log('🔍 検索語を展開中...', term);
        const termVariantsByWord = expandTerms(term);
        console.log('📋 展開結果:', termVariantsByWord);
        
        console.log('🔎 検索実行中...');
        performClientSideSearch(booksCache, termVariantsByWord);
        console.log('✅ 検索完了');
      } catch (err) {
        console.error('データ取得エラー: ', err);
        renderMessage(`データの取得中にエラーが発生しました: ${err.message || '不明なエラー'}`);
      }
    }

    // クライアント側フィルタリング（Firebaseの読み込み削減）
    function performClientSideSearch(books, termVariantsByWord) {
      const results = [];
      
      books.forEach((item) => {
        const data = item.data;

        // 検索対象フィールドを広げる
        const searchable = [
          data.title,
          data.authors || data.author,
          data.publisher,
          data.series,
          data.categories || data.category,
          data.description,
          data.call_number,
          data.accession_number,
          data.isbn13 || data.isbn
        ].filter(Boolean).join(' ');

        const searchableNorm = normalizeForSearch(searchable);
        const isbnDigits = onlyDigits(data.isbn13 || data.isbn || '');

        // AND: すべての語について少なくとも1つのバリアントがマッチ
        const ok = termVariantsByWord.every(variants => {
          return variants.some(v => {
            // ISBN数字一致
            if (/^[0-9x]+$/i.test(v) && v.length >= 9) {
              return isbnDigits.includes(v);
            }
            return searchableNorm.includes(v);
          });
        });

        if (ok) results.push(item);
      });

      renderResults(results);
    }

    // 予約ボタン（カード）
    window.reserveFromCard = async function(bookId){
      if (!confirm('この本を予約しますか？')) return;
      const res = await placeReservationInternal(bookId);
      if (res.ok) {
        alert('予約を受け付けました');
      } else {
        alert(res.msg || '予約に失敗しました');
      }
    };

    // カードタップで詳細
    window.openBookDetail = openBookDetail;
    window.closeBookDetail = closeBookDetail;
    window.confirmReserveFromDetail = confirmReserveFromDetail;

    // 検索ボタンのイベントリスナー
    if (searchBtn) {
      searchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        searchBooksImpl(e);
      });
    }

    // Enterキーで検索実行
    if (searchInput) {
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          searchBooksImpl(e);
        }
      });
    }

    // グローバル公開（HTML の onclick 用）
    window.searchBooks = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      searchBooksImpl(event);
    };
  });
})();
