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

  function normalizeLanguage(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (['ja', 'jpn', 'jp', 'japanese', '日本語'].includes(s)) return 'ja';
    if (['en', 'eng', 'english', '英語'].includes(s)) return 'en';
    return s;
  }

  function extractPublicationYear(data) {
    const keys = [
      'publication_year',
      'published_year',
      'publish_year',
      'year',
      'publication_date',
      'published_date',
      'publish_date',
      'publishedDate'
    ];

    for (const key of keys) {
      const v = data?.[key];
      if (v === undefined || v === null || v === '') continue;

      if (typeof v === 'number' && v >= 1000 && v <= 9999) return v;

      if (v?.toDate && typeof v.toDate === 'function') {
        const d = v.toDate();
        if (!isNaN(d.getTime())) return d.getFullYear();
      }

      const s = String(v);
      const m = s.match(/(19|20)\d{2}/);
      if (m) return Number(m[0]);
    }

    return null;
  }

  function splitFacetValues(raw) {
    if (Array.isArray(raw)) {
      return raw.map(v => String(v || '').trim()).filter(Boolean);
    }
    if (!raw) return [];
    return String(raw)
      .split(/[、,;/|]/g)
      .map(v => v.trim())
      .filter(Boolean);
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

  function splitTokensForFuzzy(raw) {
    return normalizeForSearch(raw)
      .split(/[\s、,.;:!?'"()\[\]{}\/\\|+*=~`@#$%^&_\-]+/)
      .filter(Boolean);
  }

  function editDistanceWithin(a, b, maxDistance) {
    const aLen = a.length;
    const bLen = b.length;
    if (Math.abs(aLen - bLen) > maxDistance) return maxDistance + 1;

    let prev = new Array(bLen + 1);
    let curr = new Array(bLen + 1);
    for (let j = 0; j <= bLen; j++) prev[j] = j;

    for (let i = 1; i <= aLen; i++) {
      curr[0] = i;
      let rowMin = curr[0];

      for (let j = 1; j <= bLen; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost
        );
        if (curr[j] < rowMin) rowMin = curr[j];
      }

      if (rowMin > maxDistance) return maxDistance + 1;
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }

    return prev[bLen];
  }

  function fuzzyTokenMatch(termToken, textToken) {
    if (!termToken || !textToken) return false;
    if (textToken.includes(termToken) || termToken.includes(textToken)) return true;

    if (termToken.length <= 2 || textToken.length <= 2) return false;

    const maxDistance = termToken.length <= 4 ? 1 : 2;
    if (Math.abs(termToken.length - textToken.length) > maxDistance) return false;

    return editDistanceWithin(termToken, textToken, maxDistance) <= maxDistance;
  }

  function buildPrefixTokens(rawTerm, normalizedAuthorFilter) {
    const rawParts = toHalfWidth(rawTerm || '').trim().split(/\s+/).filter(Boolean);
    const normalizedParts = normalizeForSearch(rawTerm || '').trim().split(/\s+/).filter(Boolean);
    const authorParts = normalizeForSearch(normalizedAuthorFilter || '').trim().split(/\s+/).filter(Boolean);
    const merged = [...rawParts, ...normalizedParts, ...authorParts];
    const dedup = [];
    const seen = new Set();

    merged.forEach((part) => {
      const key = String(part || '').trim();
      if (!key || key.length < 2) return;
      if (/^[0-9x]+$/i.test(key)) return;
      if (seen.has(key)) return;
      seen.add(key);
      dedup.push(key);
    });

    return dedup.slice(0, 3);
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

  // 検索条件ごとの候補キャッシュ
  const booksCache = new Map();
  const CACHE_DURATION = 5 * 60 * 1000;
  const SEARCH_TARGET_RESULTS = 30;
  const SEARCH_MIN_RESULTS_FOR_STOP = 8;
  const FALLBACK_SCAN_BATCH_SIZE = 80;
  const FALLBACK_SCAN_MAX_DOCS = 800;

  function buildSearchCacheKey(term, filters) {
    return JSON.stringify({
      term: normalizeForSearch(term || '').trim(),
      category: filters?.category || '',
      language: filters?.language || '',
      author: filters?.author || '',
      maxYear: filters?.maxYear || null
    });
  }

  function getCachedCandidates(cacheKey) {
    const entry = booksCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_DURATION) {
      booksCache.delete(cacheKey);
      return null;
    }
    return entry.items;
  }

  function setCachedCandidates(cacheKey, items) {
    booksCache.set(cacheKey, { items, timestamp: Date.now() });
    if (booksCache.size > 20) {
      const oldestKey = booksCache.keys().next().value;
      booksCache.delete(oldestKey);
    }
  }

  // 参照は DOM 解析後に取得
  document.addEventListener('DOMContentLoaded', () => {
    const resultsContainer = document.getElementById('resultsContainer');
    const resultsCount = document.getElementById('resultsCount');
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.querySelector('.search-btn-enhanced, .opac-search-btn');
    const categoryFilter = document.getElementById('categoryFilter');
    const languageFilter = document.getElementById('statusFilter');
    const authorKeyword = document.getElementById('authorKeyword');
    const pubRange = document.getElementById('pubRange');
    const pubRangeValue = document.getElementById('pubRangeValue');

    function updateFacetOptions(books) {
      if (!Array.isArray(books) || books.length === 0) return;

      const genreMap = new Map();
      const languageMap = new Map();

      books.forEach((item) => {
        const data = item?.data || {};

        const genreCandidates = [
          ...splitFacetValues(data.categories),
          ...splitFacetValues(data.category),
          ...splitFacetValues(data.genre)
        ];

        genreCandidates.forEach((name) => {
          const key = normalizeForSearch(name);
          if (!key) return;
          if (!genreMap.has(key)) {
            genreMap.set(key, name);
          }
        });

        const languageCandidates = [
          ...splitFacetValues(data.language),
          ...splitFacetValues(data.lang),
          ...splitFacetValues(data.locale)
        ];

        languageCandidates.forEach((name) => {
          const key = normalizeLanguage(name);
          if (!key) return;
          if (languageMap.has(key)) return;

          let label = name;
          if (key === 'ja') label = '日本語';
          if (key === 'en') label = '英語';

          languageMap.set(key, label);
        });
      });

      if (categoryFilter) {
        const prev = categoryFilter.value;
        const genreOptions = [...genreMap.entries()]
          .sort((a, b) => a[1].localeCompare(b[1], 'ja'))
          .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
          .join('');

        categoryFilter.innerHTML = `<option value="">すべて</option>${genreOptions}`;
        if (prev && genreMap.has(prev)) categoryFilter.value = prev;
      }

      if (languageFilter) {
        const prev = languageFilter.value;
        const languageOptions = [...languageMap.entries()]
          .sort((a, b) => a[1].localeCompare(b[1], 'ja'))
          .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
          .join('');

        languageFilter.innerHTML = `<option value="">すべて</option>${languageOptions}`;
        if (prev && languageMap.has(prev)) languageFilter.value = prev;
      }
    }

    function getTerm() {
      return (searchInput?.value || '').trim();
    }

    function getFilterState() {
      const maxYearRaw = Number(pubRange?.value || 0);
      const maxYearLimit = Number(pubRange?.max || 0);
      const maxYear = (
        Number.isFinite(maxYearRaw) &&
        maxYearRaw > 0 &&
        Number.isFinite(maxYearLimit) &&
        maxYearLimit > 0 &&
        maxYearRaw < maxYearLimit
      ) ? maxYearRaw : null;

      return {
        category: normalizeForSearch(categoryFilter?.value || '').trim(),
        language: normalizeLanguage(languageFilter?.value || ''),
        author: normalizeForSearch(authorKeyword?.value || '').trim(),
        maxYear
      };
    }

    function hasActiveFilter(filters) {
      return Boolean(filters.category || filters.language || filters.author || filters.maxYear);
    }

    function updatePubRangeLabel() {
      if (!pubRange || !pubRangeValue) return;
      const current = Number(pubRange.value || 0);
      const upper = Number(pubRange.max || 0);
      if (upper > 0 && current >= upper) {
        pubRangeValue.textContent = '指定なし';
        return;
      }
      pubRangeValue.textContent = `〜 ${pubRange.value}`;
    }

    function renderMessage(message) {
      if (resultsCount) resultsCount.textContent = '0件';
      if (resultsContainer) {
        resultsContainer.innerHTML = `<div class="no-results-message"><p>${escapeHtml(message)}</p></div>`;
      }
    }

    function renderResults(items) {
      if (!Array.isArray(items) || items.length === 0) {
        renderMessage('該当する蔵書は見つかりませんでした。');
        return;
      }

      if (resultsCount) {
        resultsCount.textContent = `${items.length}件`;
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

    async function addCandidatesFromQuery(queryRef, candidateMap) {
      try {
        const snapshot = await queryRef.get();
        snapshot.forEach((doc) => {
          if (!candidateMap.has(doc.id)) {
            candidateMap.set(doc.id, { id: doc.id, data: doc.data() || {} });
          }
        });
        return snapshot.size;
      } catch (err) {
        console.warn('候補クエリをスキップ:', err?.message || err);
        return 0;
      }
    }

    function isBookMatched(item, termVariantsByWord, filters) {
      const data = item?.data || {};

      const searchable = [
        data.title,
        data.search_blob,
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
      const searchableTokens = splitTokensForFuzzy(searchableNorm);
      const isbnDigits = onlyDigits(data.isbn13 || data.isbn || '');
      const categoryNorm = normalizeForSearch([data.categories, data.category, data.genre].filter(Boolean).join(' '));
      const authorNorm = normalizeForSearch([data.authors, data.author].filter(Boolean).join(' '));
      const lang = normalizeLanguage(data.language || data.lang || data.locale || '');
      const pubYear = extractPublicationYear(data);

      const keywordOk = termVariantsByWord.length === 0 || termVariantsByWord.every((variants) => {
        return variants.some((variant) => {
          const normalizedVariant = normalizeForSearch(variant || '').trim();
          if (!normalizedVariant) return false;

          if (/^[0-9x]+$/i.test(normalizedVariant) && normalizedVariant.length >= 9) {
            return isbnDigits.includes(onlyDigits(normalizedVariant));
          }

          if (searchableNorm.includes(normalizedVariant)) return true;
          return searchableTokens.some((token) => fuzzyTokenMatch(normalizedVariant, token));
        });
      });

      if (!keywordOk) return false;

      if (filters.category && !categoryNorm.includes(filters.category)) return false;
      if (filters.author && !authorNorm.includes(filters.author)) return false;
      if (filters.language && lang !== filters.language) return false;
      if (filters.maxYear && (!pubYear || pubYear > filters.maxYear)) return false;

      return true;
    }

    function performClientSideSearch(books, termVariantsByWord, filters, options = {}) {
      const results = [];
      const maxResults = Number(options.maxResults || 0);

      books.forEach((item) => {
        if (!isBookMatched(item, termVariantsByWord, filters)) return;
        results.push(item);
      });

      if (maxResults > 0) {
        return results.slice(0, maxResults);
      }
      return results;
    }

    async function loadFallbackCandidates(db, candidateMap, termVariantsByWord, filters) {
      let scanned = 0;
      let cursor = null;
      let matched = performClientSideSearch([...candidateMap.values()], termVariantsByWord, filters, {
        maxResults: SEARCH_TARGET_RESULTS
      });

      while (scanned < FALLBACK_SCAN_MAX_DOCS && matched.length < SEARCH_MIN_RESULTS_FOR_STOP) {
        let queryRef = db.collection('books')
          .orderBy(firebase.firestore.FieldPath.documentId())
          .limit(FALLBACK_SCAN_BATCH_SIZE);

        if (cursor) {
          queryRef = queryRef.startAfter(cursor);
        }

        const snap = await queryRef.get();
        if (snap.empty) break;

        scanned += snap.size;
        cursor = snap.docs[snap.docs.length - 1];

        snap.forEach((doc) => {
          if (!candidateMap.has(doc.id)) {
            candidateMap.set(doc.id, { id: doc.id, data: doc.data() || {} });
          }
        });

        matched = performClientSideSearch([...candidateMap.values()], termVariantsByWord, filters, {
          maxResults: SEARCH_TARGET_RESULTS
        });

        if (snap.size < FALLBACK_SCAN_BATCH_SIZE) break;
      }

      return {
        candidates: [...candidateMap.values()],
        matched,
        scanned
      };
    }

    async function fetchCandidates(db, term, filters, termVariantsByWord) {
      const cacheKey = buildSearchCacheKey(term, filters);
      const cached = getCachedCandidates(cacheKey);
      if (cached) {
        return {
          candidates: cached,
          matched: performClientSideSearch(cached, termVariantsByWord, filters),
          source: 'cache'
        };
      }

      const candidateMap = new Map();
      const isbnDigits = onlyDigits(term);

      if (isbnDigits.length >= 9) {
        await Promise.all([
          addCandidatesFromQuery(db.collection('books').where('isbn13', '==', isbnDigits).limit(5), candidateMap),
          addCandidatesFromQuery(db.collection('books').where('isbn', '==', isbnDigits).limit(5), candidateMap)
        ]);
      }

      const prefixTokens = buildPrefixTokens(term, filters.author);
      const prefixTasks = [];
      prefixTokens.forEach((token) => {
        prefixTasks.push(addCandidatesFromQuery(
          db.collection('books').orderBy('title').startAt(token).endAt(token + '\uf8ff').limit(20),
          candidateMap
        ));
        prefixTasks.push(addCandidatesFromQuery(
          db.collection('books').orderBy('search_blob').startAt(token).endAt(token + '\uf8ff').limit(20),
          candidateMap
        ));
        prefixTasks.push(addCandidatesFromQuery(
          db.collection('books').orderBy('authors').startAt(token).endAt(token + '\uf8ff').limit(20),
          candidateMap
        ));
        prefixTasks.push(addCandidatesFromQuery(
          db.collection('books').orderBy('author').startAt(token).endAt(token + '\uf8ff').limit(20),
          candidateMap
        ));
      });

      if (prefixTasks.length) {
        await Promise.all(prefixTasks);
      }

      let candidates = [...candidateMap.values()];
      let matched = performClientSideSearch(candidates, termVariantsByWord, filters, {
        maxResults: SEARCH_TARGET_RESULTS
      });

      if (matched.length < SEARCH_MIN_RESULTS_FOR_STOP) {
        const fallback = await loadFallbackCandidates(db, candidateMap, termVariantsByWord, filters);
        candidates = fallback.candidates;
        matched = fallback.matched;
      }

      setCachedCandidates(cacheKey, candidates);
      return {
        candidates,
        matched,
        source: 'firestore'
      };
    }

    async function searchBooksImpl(event) {
      // デフォルト動作を防ぐ
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      const termRaw = getTerm();
      const term = termRaw.trim();
      const filters = getFilterState();
      const keywordEnabled = Boolean(term);
      const filterEnabled = hasActiveFilter(filters);

      if (!keywordEnabled && !filterEnabled) {
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

        const db = firebase.firestore();
        const termVariantsByWord = keywordEnabled ? expandTerms(term) : [];
        const fetched = await fetchCandidates(db, term, filters, termVariantsByWord);

        updateFacetOptions(fetched.candidates);
        renderResults(fetched.matched);
        console.log(`✅ 検索完了 (${fetched.source}) 候補:${fetched.candidates.length}件 / 表示:${fetched.matched.length}件`);
      } catch (err) {
        console.error('データ取得エラー: ', err);
        renderMessage(`データの取得中にエラーが発生しました: ${err.message || '不明なエラー'}`);
      }
    }

    function triggerSearchByFilter(event) {
      if (event?.target === pubRange) {
        updatePubRangeLabel();
      }
      const filters = getFilterState();
      if (getTerm() || hasActiveFilter(filters)) {
        searchBooksImpl();
      }
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

    if (categoryFilter) categoryFilter.addEventListener('change', triggerSearchByFilter);
    if (languageFilter) languageFilter.addEventListener('change', triggerSearchByFilter);
    if (authorKeyword) authorKeyword.addEventListener('input', triggerSearchByFilter);
    if (pubRange) pubRange.addEventListener('input', triggerSearchByFilter);

    updatePubRangeLabel();

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
