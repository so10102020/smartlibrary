(function(){
  'use strict';
  
  // グローバル変数
  let isAdminAuthenticated = false;
  let scannedBooks = [];
  let csvData = [];
  
  // Firebase参照をグローバルから取得
  let auth, db;
  
  // Firebase初期化を待つ関数
  function waitForFirebase() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50; // 5秒間待機
      
      const checkFirebase = () => {
        attempts++;
        if (window.firebase && window.firebase.auth && window.firebase.firestore) {
          auth = window.firebase.auth();
          db = window.firebase.firestore();
          resolve();
        } else if (attempts >= maxAttempts) {
          reject(new Error('Firebaseの初期化がタイムアウトしました'));
        } else {
          setTimeout(checkFirebase, 100);
        }
      };
      
      checkFirebase();
    });
  }
  
  // DOM utilities
  const $ = (id) => document.getElementById(id);
  const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  const setHtml = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  const showElement = (id, show = true) => { const el = $(id); if (el) el.style.display = show ? 'block' : 'none'; };
  
  function showMessage(elementId, message, type = 'info') {
    const el = $(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `message ${type}`;
  }
  
  function showActionResult(title, html, type = 'info') {
    const resultEl = $('actionResult');
    if (!resultEl) return;
    let className = 'result-card';
    let icon = '📋';
    switch(type) {
      case 'success': className += ' success'; icon = '✅'; break;
      case 'error': className += ' error'; icon = '❌'; break;
      case 'warning': className += ' warning'; icon = '⚠️'; break;
      case 'processing': className += ' processing'; icon = '⏳'; break;
    }
    resultEl.className = className;
    resultEl.innerHTML = `<h3>${icon} ${title}</h3><div>${html}</div>`;
    showElement('actionResultSection', true);
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // エスケープ関数を追加
  function escapeHtml(text) {
    if (!text) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.toString().replace(/[&<>"']/g, function(m) { return map[m]; });
  }
  
  // ISBN utilities
  function toIsbn13(code) {
    const digits = (code || '').replace(/[^0-9Xx]/g, '');
    if (digits.length === 13) return digits;
    if (digits.length !== 10) return '';
    const core = '978' + digits.substring(0, 9);
    let sum = 0;
    for (let i = 0; i < core.length; i++) {
      const n = parseInt(core[i], 10);
      sum += (i % 2 === 0) ? n : n * 3;
    }
    const cd = (10 - (sum % 10)) % 10;
    return core + String(cd);
  }
  
  function extractIsbn13(raw) {
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

  // ===== 検索用 正規化/トークン化ユーティリティ =====
  function toHalfWidth(str){
    return String(str || '')
      .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
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
  function edgeNgramsAscii(token, min=2, max=10){
    const out = [];
    const n = Math.min(max, token.length);
    for (let i=min; i<=n; i++) out.push(token.slice(0,i));
    return out;
  }
  function tokenizeForIndex(blob){
    const s = normalizeForSearch(blob);
    const parts = s.split(/[^\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}a-z0-9]+/iu).filter(Boolean);
    const set = new Set();
    for (const p of parts){
      if (/^[a-z0-9]+$/.test(p)) {
        set.add(p);
        edgeNgramsAscii(p).forEach(t => set.add(t));
      } else {
        // 日本語トークンはそのまま。
        set.add(p);
      }
    }
    // 安全のため上限
    return Array.from(set).slice(0, 300);
  }

  // 初期管理者設定用（コンソールで実行）
  async function setupInitialAdmin(email) {
    const user = auth && auth.currentUser;
    if (!user) {
      console.error('ログインが必要です');
      return;
    }
    
    try {
      await db.collection('users').doc(user.uid).set({
        email: user.email,
        display_name: user.displayName || user.email,
        role: 'admin',
        is_admin: true,
        admin_granted_at: firebase.firestore.FieldValue.serverTimestamp(),
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      
      console.log('初期管理者設定完了:', user.email);
    } catch (error) {
      console.error('初期管理者設定エラー:', error);
    }
  }

  // 使用方法: ブラウザのコンソールで実行
  // setupInitialAdmin();
  
  // 管理者権限チェック（uid優先 + user_idフォールバック）
  async function checkAdminPermission(currentUser) {
    const uid = currentUser?.uid;
    if (!uid) return false;

    try {
      // 1) uid をキーにした users/{uid} を優先
      let userDoc = await db.collection('users').doc(uid).get();
      let userData = userDoc.exists ? userDoc.data() : null;

      // 2) 見つからなければ email / user_id ベースでフォールバック検索
      if (!userData) {
        if (currentUser.email) {
          const byEmail = await db.collection('users')
            .where('email','==', currentUser.email)
            .limit(1)
            .get();
          if (!byEmail.empty) {
            userDoc = byEmail.docs[0];
            userData = userDoc.data();
          }
        }
      }
      if (!userData && currentUser.uid) {
        const byUserId = await db.collection('users')
          .where('user_id','==', currentUser.uid)
          .limit(1)
          .get();
        if (!byUserId.empty) {
          const d = byUserId.docs[0];
          userDoc = d;
          userData = d.data();
        }
      }

      if (!userData) return false;

      // role/is_admin いずれかで admin 判定
      return userData.role === 'admin' || userData.is_admin === true;
    } catch (error) {
      console.error('Admin permission check error:', error);
      return false;
    }
  }

  // 管理者認証
  async function verifyAdmin() {
    try {
      await waitForFirebase();
      const user = auth.currentUser;
      if (!user) {
        showMessage('adminAuthMsg', 'ログインが必要です。ログインページへ移動します。', 'error');
        window.location.href = 'login.html';
        return;
      }

      const isAdmin = await checkAdminPermission(user);
      if (!isAdmin) {
        isAdminAuthenticated = false;
        showMessage(
          'adminAuthMsg',
          'このアカウントには管理者権限がありません。必要に応じて users コレクションで role を admin に設定してください。',
          'error'
        );
        // 一時的にリダイレクトをしない
        return;
      }

      isAdminAuthenticated = true;
      showMessage('adminAuthMsg', `管理者として認証されました: ${user.email}`, 'success');
      const adminAuthSection = document.getElementById('adminAuthSection');
      if (adminAuthSection) adminAuthSection.style.display = 'none';
      showElement('mainContent', true);
      showTab('scan');
    } catch (error) {
      console.error('管理者認証エラー:', error);
      showMessage('adminAuthMsg', `認証エラー: ${error.message}`, 'error');
    }
  }

  // タブ表示関数（admin.htmlに合わせて修正）
  function showTab(tabKey) {
    // 全タブを非表示
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    // ボタンのactive解除
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    // 対象タブを表示
    const tabEl = document.getElementById(`${tabKey}Tab`);
    if (tabEl) tabEl.classList.add('active');
    
    // 対応ボタンをactiveに
    const btn = document.querySelector(`.tab-btn[onclick="showTab('${tabKey}')"]`);
    if (btn) btn.classList.add('active');
  }

  // バーコードスキャナー開始（グローバル）
  function startBookScanner() {
    // バーコードスキャナーのテストページに移動
    window.location.href = 'brsc-test.html';
  }

  // 書籍情報API取得
  async function fetchBookMetadata(isbn13) {
    try {
      // Google Books API
      const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}`);
      if (response.ok) {
        const data = await response.json();
        const item = (data.items && data.items[0]) ? data.items[0].volumeInfo : null;
        if (item) {
          return {
            isbn13,
            title: item.title || '',
            authors: (item.authors || []).join(', '),
            publisher: item.publisher || '',
            published: item.publishedDate || '',
            pages: item.pageCount || null,
            series: item.series || '',
            price: item.listPrice?.amount || null,
            description: item.description || '',
            categories: (item.categories || []).join(', '),
            thumbnail: item.imageLinks?.thumbnail || ''
          };
        }
      }
    } catch (error) {
      console.warn('Google Books API error:', error);
    }
    
    try {
      // Open Library API
      const response2 = await fetch(`https://openlibrary.org/isbn/${isbn13}.json`);
      if (response2.ok) {
        const data2 = await response2.json();
        return {
          isbn13,
          title: data2.title || '',
          authors: Array.isArray(data2.authors) ? data2.authors.map(a => a.name || a.key).join(', ') : '',
          publisher: Array.isArray(data2.publishers) ? data2.publishers.join(', ') : '',
          published: data2.publish_date || '',
          pages: data2.number_of_pages || null,
          series: '',
          price: null,
          description: '',
          categories: '',
          thumbnail: ''
        };
      }
    } catch (error) {
      console.warn('Open Library API error:', error);
    }
    
    return {
      isbn13,
      title: '',
      authors: '',
      publisher: '',
      published: '',
      pages: null,
      series: '',
      price: null,
      description: '',
      categories: '',
      thumbnail: ''
    };
  }
  
  // 図書登録（検索用フィールドを含めて保存）
  async function registerBook(bookData) {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('ログインが必要です');
      if (!isAdminAuthenticated) throw new Error('管理者権限が必要です');
      
      const docRef = db.collection('books').doc();
      const now = firebase.firestore.FieldValue.serverTimestamp();

      // 検索用フィールド生成
      const isbnRaw = bookData.isbn13 || bookData.isbn || '';
      const isbnDigits = onlyDigits(isbnRaw);
      const searchBlob = normalizeForSearch([
        bookData.title,
        bookData.authors || bookData.author,
        bookData.publisher,
        bookData.series,
        bookData.categories || bookData.category,
        bookData.description,
        bookData.call_number,
        bookData.accession_number,
        isbnRaw
      ].filter(Boolean).join(' '));
      const searchTokens = tokenizeForIndex(searchBlob);
      
      const bookDoc = {
        book_id: docRef.id,
        isbn13: bookData.isbn13 || null,
        isbn: bookData.isbn13 || null,
        title: bookData.title,
        authors: bookData.authors || '',
        publisher: bookData.publisher || '',
        published: bookData.published || '',
        pages: bookData.pages || null,
        series: bookData.series || '',
        price: bookData.price || null,
        size: bookData.size || '',
        description: bookData.description || '',
        categories: bookData.categories || '',
        category: bookData.category || '',
        thumbnail: bookData.thumbnail || '',
        stock_count: parseInt(bookData.stock_count) || 1,
        available_count: parseInt(bookData.stock_count) || 1,
        notes: bookData.notes || '',
        // 追加保存フィールド
        status: bookData.status || '在架',
        copy_type: bookData.copy_type || '',
        accession_number: bookData.accession_number || '',
        call_number: bookData.call_number || '',
        material_type: bookData.material_type || '図書',
        acquisition_type: bookData.acquisition_type || '',
        acquisition_price: bookData.acquisition_price || null,
        acquisition_date: bookData.acquisition_date || '',
        current_location: bookData.current_location || '',
        shelf_location: bookData.shelf_location || '',
        temp_location: bookData.temp_location || '',
        loan_policy: bookData.loan_policy || '',
        loan_total: parseInt(bookData.loan_total) || 0,
        tags: Array.isArray(bookData.tags) ? bookData.tags : parseTags(bookData.tags),
        // 検索用フィールド
        search_blob: searchBlob,
        search_tokens: searchTokens,
        isbn_digits: isbnDigits,
        
        created_at: now,
        updated_at: now,
        created_by: user.uid
      };
      
      await docRef.set(bookDoc);
      return { id: docRef.id, data: bookDoc };
      
    } catch (error) {
      console.error('Book registration error:', error);
      throw error;
    }
  }

  // 既存データの再インデックス（管理者向け・手動実行）
  async function backfillSearchIndex(limitCount=500){
    if (!isAdminAuthenticated) { console.warn('admin only'); return; }
    showActionResult('処理中','検索インデックスを再構築中...','processing');
    try {
      const snap = await db.collection('books').limit(limitCount).get();
      let updated = 0;
      for (const doc of snap.docs){
        const d = doc.data() || {};
        const isbnRaw = d.isbn13 || d.isbn || '';
        const isbnDigits = onlyDigits(isbnRaw);
        const searchBlob = normalizeForSearch([
          d.title,
          d.authors || d.author,
          d.publisher,
          d.series,
          d.categories || d.category,
          d.description,
          d.call_number,
          d.accession_number,
          isbnRaw
        ].filter(Boolean).join(' '));
        const searchTokens = tokenizeForIndex(searchBlob);
        await doc.ref.update({
          search_blob: searchBlob,
          search_tokens: searchTokens,
          isbn_digits: isbnDigits,
          updated_at: firebase.firestore.FieldValue.serverTimestamp()
        });
        updated++;
      }
      showActionResult('完了', `再インデックス更新: ${updated}件`, 'success');
    } catch (e){
      console.error(e);
      showActionResult('エラー', '再インデックスに失敗しました。', 'error');
    }
  }

  // 管理者設定UI
  async function showAdminManagement() {
    try {
      const adminList = await getAdminList();
      let html = '<h3>🔧 管理者設定</h3>';
      
      // 新しい管理者追加
      html += `
        <div class="admin-form">
          <h4>管理者権限の付与</h4>
          <div class="form-group">
            <input type="email" id="newAdminEmail" placeholder="メールアドレス">
            <button onclick="addNewAdmin()" class="btn btn-primary">管理者に設定</button>
          </div>
        </div>
      `;

      // 現在の管理者一覧
      html += '<div class="admin-list"><h4>現在の管理者</h4>';
      if (adminList.length > 0) {
        html += '<ul>';
        adminList.forEach(admin => {
          const grantedDate = admin.admin_granted_at?.toDate?.()?.toLocaleDateString() || '不明';
          html += `
            <li class="admin-item">
              <span>${escapeHtml(admin.display_name)} (${escapeHtml(admin.email)})</span>
              <span class="admin-date">設定日: ${grantedDate}</span>
              <button onclick="removeAdmin('${escapeHtml(admin.email)}')" class="btn btn-sm btn-danger">権限削除</button>
            </li>`;
        });
        html += '</ul>';
      } else {
        html += '<p>管理者が設定されていません</p>';
      }
      html += '</div>';
      
      $('adminManagementContent').innerHTML = html;
      showElement('adminManagementSection', true);
    } catch (error) {
      showActionResult('エラー', '管理者設定の取得に失敗しました', 'error');
    }
  }
  
  // 管理者リストを取得（role==admin 基準に統一）
  async function getAdminList() {
    try {
      const usersRef = db.collection('users');
      const snapshot = await usersRef.where('role', '==', 'admin').get();
      const admins = [];
      
      snapshot.forEach(doc => {
        const userData = doc.data();
        admins.push({
          uid: doc.id,
          email: userData.email,
          display_name: userData.display_name || userData.email,
          admin_granted_at: userData.admin_granted_at,
          created_at: userData.created_at
        });
      });
      
      return admins;
    } catch (error) {
      console.error('Get admin list error:', error);
      throw error;
    }
  }
  
  // ユーザーを管理者に設定（emailベース）
  async function setUserAsAdmin(email) {
    if (!email || !email.trim()) {
      throw new Error('メールアドレスが必要です');
    }
    
    try {
      // メールアドレスでユーザーを検索
      const usersRef = db.collection('users');
      const snapshot = await usersRef.where('email', '==', email.trim()).get();
      
      if (snapshot.empty) {
        throw new Error('指定されたメールアドレスのユーザーが見つかりません');
      }
      
      const userDoc = snapshot.docs[0];
      await userDoc.ref.update({
        role: 'admin',
        is_admin: true,
        admin_granted_at: firebase.firestore.FieldValue.serverTimestamp(),
        updated_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      
      return { success: true, message: `${email} を管理者に設定しました` };
    } catch (error) {
      console.error('Set user as admin error:', error);
      throw error;
    }
  }
  
  // 管理者権限を削除（emailベース）
  async function removeAdminPermission(email) {
    try {
      const usersRef = db.collection('users');
      const snapshot = await usersRef.where('email', '==', email).get();
      
      if (snapshot.empty) {
        throw new Error('指定されたユーザーが見つかりません');
      }
      
      const userDoc = snapshot.docs[0];
      await userDoc.ref.update({
        role: 'user',
        is_admin: false,
        admin_removed_at: firebase.firestore.FieldValue.serverTimestamp(),
        updated_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      
      return { success: true, message: `${email} の管理者権限を削除しました` };
    } catch (error) {
      console.error('Remove admin permission error:', error);
      throw error;
    }
  }

  async function addNewAdmin() {
    const email = $('newAdminEmail').value.trim();
    if (!email) {
      showActionResult('エラー', 'メールアドレスを入力してください', 'error');
      return;
    }
    
    try {
      showActionResult('処理中', '管理者権限を設定中...', 'processing');
      const result = await setUserAsAdmin(email);
      showActionResult('設定完了', result.message, 'success');
      $('newAdminEmail').value = '';
      await showAdminManagement(); // リスト更新
    } catch (error) {
      showActionResult('設定失敗', error.message, 'error');
    }
  }
  
  async function removeAdmin(email) {
    if (!confirm(`${email} の管理者権限を削除しますか？`)) return;
    
    try {
      showActionResult('処理中', '管理者権限を削除中...', 'processing');
      const result = await removeAdminPermission(email);
      showActionResult('削除完了', result.message, 'success');
      await showAdminManagement(); // リスト更新
    } catch (error) {
      showActionResult('削除失敗', error.message, 'error');
    }
  }
  
  // スキャン登録機能
  let currentScannedBook = null;
  
  async function stopBookScanner() {
    if (typeof stopCamera === 'function') {
      await stopCamera();
      setText('scanProgress', '');
    }
  }
  
  // バーコードスキャナーからの結果を受け取る
  async function handleBookScanResult(isbn) {
    const isbn13 = extractIsbn13(isbn);
    if (!isbn13) {
      showActionResult('エラー', 'ISBNが認識できませんでした', 'error');
      return;
    }
    
    setText('scanProgress', '書籍情報を取得中...');
    
    try {
      const bookData = await fetchBookMetadata(isbn13);
      currentScannedBook = { ...bookData, stock_count: 1 };
      
      displayBookInfo(currentScannedBook, 'bookInfoCard');
      showElement('scanResultSection', true);
      setText('scanProgress', '書籍情報を取得しました');
      
    } catch (error) {
      console.error('Book scan error:', error);
      showActionResult('エラー', '書籍情報の取得に失敗しました', 'error');
    }
  }
  
  function displayBookInfo(bookData, containerId) {
    const container = $(containerId);
    if (!container) return;
    
    container.innerHTML = `
      <div class="book-card">
        ${bookData.thumbnail ? `<img src="${bookData.thumbnail}" alt="書籍画像" class="book-thumbnail">` : ''}
        <div class="book-details">
          <h4>${escapeHtml(bookData.title || '不明')}</h4>
          <p><strong>ISBN:</strong> ${bookData.isbn13 || '不明'}</p>
          <p><strong>著者:</strong> ${escapeHtml(bookData.authors || '不明')}</p>
          <p><strong>出版社:</strong> ${escapeHtml(bookData.publisher || '不明')}</p>
          <p><strong>出版年:</strong> ${bookData.published || '不明'}</p>
          ${bookData.pages ? `<p><strong>頁数:</strong> ${bookData.pages}ページ</p>` : ''}
          ${bookData.price ? `<p><strong>定価:</strong> ${bookData.price}円</p>` : ''}
          <div class="stock-control">
            <label>在庫数: </label>
            <input type="number" value="${bookData.stock_count || 1}" min="1" onchange="updateBookStock(this.value)">
          </div>
        </div>
      </div>
    `;
  }
  
  function updateBookStock(value) {
    if (currentScannedBook) {
      currentScannedBook.stock_count = parseInt(value) || 1;
    }
  }
  
  async function registerScannedBook() {
    if (!currentScannedBook) {
      showActionResult('エラー', '登録する書籍が選択されていません', 'error');
      return;
    }
    
    try {
      showActionResult('処理中', '図書を登録しています...', 'processing');
      const result = await registerBook(currentScannedBook);
      showActionResult('登録完了', `「${escapeHtml(currentScannedBook.title)}」を登録しました`, 'success');
      clearScanResult();
    } catch (error) {
      showActionResult('登録失敗', error.message, 'error');
    }
  }
  
  function clearScanResult() {
    currentScannedBook = null;
    showElement('scanResultSection', false);
    setHtml('bookInfoCard', '');
  }
  
  // 手動登録
  async function fetchBookDataByIsbn() {
    const isbn = $('manualIsbn').value.trim();
    const isbn13 = extractIsbn13(isbn);
    
    if (!isbn13) {
      showActionResult('エラー', '有効なISBNを入力してください', 'error');
      return;
    }
    
    try {
      showActionResult('処理中', '書籍情報を取得中...', 'processing');
      const bookData = await fetchBookMetadata(isbn13);
      
      // フォームに情報を入力
      $('manualTitle').value = bookData.title;
      $('manualAuthors').value = bookData.authors;
      $('manualPublisher').value = bookData.publisher;
      $('manualPublished').value = bookData.published;
      $('manualSeries').value = bookData.series;
      $('manualPages').value = bookData.pages || '';
      $('manualPrice').value = bookData.price || '';
      $('manualCategory').value = bookData.categories;
      
      showActionResult('取得完了', '書籍情報を取得しました', 'success');
      
    } catch (error) {
      showActionResult('取得失敗', '書籍情報の取得に失敗しました', 'error');
    }
  }
  
  async function submitManualBook() {
    try {
      const formData = {
        isbn13: extractIsbn13($('manualIsbn').value),
        title: $('manualTitle').value.trim(),
        authors: $('manualAuthors').value.trim(),
        publisher: $('manualPublisher').value.trim(),
        published: $('manualPublished').value.trim(),
        series: $('manualSeries').value.trim(),
        pages: (function(){
          const v = $('manualPages').value;
          if (!v) return null;
          const n = parseInt(String(v).replace(/[^0-9]/g,''));
          return Number.isFinite(n) ? n : null;
        })(),
        size: $('manualSize').value.trim(),
        price: parseInt($('manualPrice').value) || null,
        stock_count: parseInt($('manualStock').value) || 1,
        category: $('manualCategory').value.trim(),
        notes: $('manualNotes').value.trim(),
        // 追加: 館内フィールド
        status: $('manualStatus')?.value || '在架',
        copy_type: $('manualCopyType')?.value || '',
        accession_number: $('manualAccessionNumber')?.value.trim() || '',
        call_number: $('manualCallNumber')?.value.trim() || '',
        material_type: $('manualMaterialType')?.value.trim() || '図書',
        acquisition_type: $('manualAcquisitionType')?.value.trim() || '',
        acquisition_price: parseInt($('manualAcquisitionPrice')?.value) || null,
        acquisition_date: $('manualAcquisitionDate')?.value || '',
        current_location: $('manualCurrentLocation')?.value.trim() || '',
        shelf_location: $('manualShelfLocation')?.value.trim() || '',
        temp_location: $('manualTempLocation')?.value.trim() || '',
        loan_policy: $('manualLoanPolicy')?.value.trim() || '',
        loan_total: parseInt($('manualLoanTotal')?.value) || 0,
        tags: parseTags($('manualTags')?.value)
      };
      
      if (!formData.title) {
        showActionResult('エラー', 'タイトルは必須です', 'error');
        return;
      }
      
      showActionResult('処理中', '図書を登録しています...', 'processing');
      await registerBook(formData);
      showActionResult('登録完了', `「${escapeHtml(formData.title)}」を登録しました`, 'success');
      clearManualForm();
      
    } catch (error) {
      showActionResult('登録失敗', error.message, 'error');
    }
  }
  
  function clearManualForm() {
    $('manualBookForm').reset();
  }
  
  // 一括登録
  async function processBatchIsbn() {
    const isbnList = $('isbnBatchList').value.trim().split('\n').filter(line => line.trim());
    if (isbnList.length === 0) {
      showActionResult('エラー', 'ISBNリストを入力してください', 'error');
      return;
    }
    
    showElement('batchProgress', true);
    const results = [];
    let processed = 0;
    
    for (const isbn of isbnList) {
      const isbn13 = extractIsbn13(isbn.trim());
      if (isbn13) {
        try {
          const bookData = await fetchBookMetadata(isbn13);
          results.push({ success: true, data: { ...bookData, stock_count: 1 } });
        } catch (error) {
          results.push({ success: false, isbn: isbn13, error: error.message });
        }
      } else {
        results.push({ success: false, isbn: isbn.trim(), error: '無効なISBN' });
      }
      
      processed++;
      const progress = (processed / isbnList.length) * 100;
      $('progressFill').style.width = `${progress}%`;
      $('progressText').textContent = `${processed}/${isbnList.length} 処理完了`;
    }
    
    displayBatchResults(results);
    showElement('batchProgress', false);
  }
  
  function displayBatchResults(results) {
    const container = $('batchResults');
    let html = '<h3>取得結果</h3>';
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    html += `<p>成功: ${successful.length}件、失敗: ${failed.length}件</p>`;
    
    if (successful.length > 0) {
      html += '<div class="batch-books">';
      successful.forEach((result, index) => {
        const book = result.data;
        html += `
          <div class="batch-book-item">
            <div class="book-info">
              <h4>${escapeHtml(book.title)}</h4>
              <p>ISBN: ${book.isbn13} | 著者: ${escapeHtml(book.authors)}</p>
            </div>
            <input type="number" value="1" min="1" onchange="updateBatchStock(${index}, this.value)">
          </div>
        `;
      });
      html += '</div>';
      html += '<button onclick="registerBatchBooks()" class="btn btn-success">全て登録</button>';
    }
    
    if (failed.length > 0) {
      html += '<h4>取得失敗</h4><ul>';
      failed.forEach(result => {
        html += `<li>ISBN: ${result.isbn} - ${result.error}</li>`;
      });
      html += '</ul>';
    }
    
    container.innerHTML = html;
    window.batchResults = results;
  }
  
  function updateBatchStock(index, value) {
    if (window.batchResults && window.batchResults[index] && window.batchResults[index].success) {
      window.batchResults[index].data.stock_count = parseInt(value) || 1;
    }
  }
  
  async function registerBatchBooks() {
    if (!window.batchResults) return;
    
    const successful = window.batchResults.filter(r => r.success);
    let registered = 0;
    
    showActionResult('処理中', '一括登録を実行中...', 'processing');
    
    for (const result of successful) {
      try {
        await registerBook(result.data);
        registered++;
      } catch (error) {
        console.error('Batch registration error:', error);
      }
    }
    
    showActionResult('一括登録完了', `${registered}/${successful.length}件の図書を登録しました`, 'success');
    clearBatchList();
  }
  
  function clearBatchList() {
    $('isbnBatchList').value = '';
    $('batchResults').innerHTML = '';
    window.batchResults = null;
  }
  
  // CSV解析用ヘルパー関数
  function normalizeKey(k){
    return String(k || '').replace(/\uFEFF/g,'').trim().toLowerCase();
  }
  function cleanRow(row){
    const out = {};
    for (const k in row){
      const nk = normalizeKey(k);
      let v = row[k];
      if (typeof v === 'string') v = v.replace(/\uFEFF/g,'').trim();
      out[nk] = v;
    }
    return out;
  }
  function getFirst(row, candidates){
    for (const key of candidates){
      const nk = normalizeKey(key);
      if (row[nk] != null && String(row[nk]).trim() !== '') return String(row[nk]).trim();
    }
    return '';
  }

  // --- CSV解析用ヘルパー拡張: 部分一致サーチを追加 ---
  function getFirstFuzzy(row, tokens){
    const entries = Object.entries(row || {});
    for (const [k, v] of entries){
      const nk = normalizeKey(k);
      for (const t of tokens){
        if (nk.includes(normalizeKey(t)) && String(v).trim() !== '') {
          return String(v).trim();
        }
      }
    }
    return '';
  }

  // タグ文字列を配列へ
  function parseTags(str){
    if (!str) return [];
    return String(str)
      .split(/[、，,;\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // CSV/Excel プレビュー
  function previewCsvFile() {
    const fileInput = $('csvFileInput');
    const file = fileInput?.files?.[0];
    if (!file) return;

    const filename = (file.name || '').toLowerCase();

    // CSVはPapaParseで堅牢に解析（ヘッダ行ありを想定）
    if (filename.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        worker: true,
        delimitersToGuess: [',', '\t', '|', ';'], // 区切り自動推定を強化（TSV対応）
        complete: (res)=>{
          try {
            csvData = (res.data || []).map(cleanRow);
            displayCsvPreview(csvData);
            showElement('csvPreview', true);
          } catch (e){
            showActionResult('エラー', `CSV解析中に失敗しました: ${escapeHtml(e.message)}`, 'error');
          }
        },
        error: (err)=>{
          showActionResult('エラー', `CSV解析エラー: ${escapeHtml(err?.message || String(err))}`, 'error');
        }
      });
      return;
    }

    // Excelは従来通りxlsxで解析
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const workbook = XLSX.read(e.target.result, { type: 'binary' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        csvData = data.map(cleanRow);
        displayCsvPreview(csvData);
        showElement('csvPreview', true);
      } catch (error) {
        showActionResult('エラー', `ファイル読み込みエラー: ${escapeHtml(error.message)}`, 'error');
      }
    };
    reader.readAsBinaryString(file);
  }

  // プレビューは最初の5行表示
  function displayCsvPreview(data) {
    if (data.length === 0) return;
    
    const headers = Object.keys(data[0]);
    let html = '<table class="preview-table"><thead><tr>';
    headers.forEach(header => {
      html += `<th>${escapeHtml(header)}</th>`;
    });
    html += '</tr></thead><tbody>';
    
    data.slice(0, 5).forEach(row => {
      html += '<tr>';
      headers.forEach(header => {
        html += `<td>${escapeHtml(row[header] || '')}</td>`;
      });
      html += '</tr>';
    });
    
    html += '</tbody></table>';
    html += `<p>プレビュー: ${Math.min(5, data.length)}/${data.length}行</p>`;
    
    $('csvPreviewTable').innerHTML = html;
  }

  // 行をアプリの書誌フィールドへマップ
  function mapCsvRow(row){
    // 厳密一致候補 + ファジー
    let title = getFirst(row, ['title','タイトル','書名','booktitle','name','タイトル (巻・版)','タイトル(巻・版)']);
    if (!title) title = getFirstFuzzy(row, ['タイトル','書名','書誌名','book title']);

    const isbnRaw = getFirst(row, ['isbn13','isbn','ＩＳＢＮ','isbn-13']);
    const authors = getFirst(row, ['authors','author','著者','著者名','編者','編著者']);
    const publisher = getFirst(row, ['publisher','出版社','出版者']);
    const published = getFirst(row, ['published','出版年','発行年','刊行年','出版日']);
    const series = getFirst(row, ['series','シリーズ']);
    const pagesStr = getFirst(row, ['pages','頁数','ページ','ページ数']);
    const size = getFirst(row, ['size','大きさ','判型']);
    const priceStr = getFirst(row, ['price','定価','価格','受入価格']); // 定価 or 受入価格
    const stockStr = getFirst(row, ['stock_count','在庫数','在庫','冊数','stock']); // 数量系のみ

    // 追加の館内フィールド
    const status = getFirst(row, ['状態','本の状態','status']);
    const copyType = getFirst(row, ['複本','copy_type']);
    const accessionNumber = getFirst(row, ['登録番号','登録no','accession','accession_number']);
    const callNumber = getFirst(row, ['請求記号','call_number']);
    const materialType = getFirst(row, ['資料区分','material_type']);
    const acquisitionType = getFirst(row, ['受入区分','acquisition_type']);
    const acquisitionPriceStr = getFirst(row, ['受入価格']);
    const acquisitionDate = getFirst(row, ['受入日付','受入日','acquisition_date']);
    const currentLocation = getFirst(row, ['現在の配架','current_location']);
    const shelfLocation = getFirst(row, ['配架場所','shelf_location']);
    const tempLocation = getFirst(row, ['一時配架','temp_location']);
    const loanPolicy = getFirst(row, ['貸出区分','loan_policy']);
    const loanTotalStr = getFirst(row, ['貸出累計','貸出累積','loan_total']);
    const tagsStr = getFirst(row, ['タグ','tags']);

    // 122p 等を数値化
    const pagesNumFromStr = pagesStr ? parseInt(String(pagesStr).replace(/[^0-9]/g,'')) : NaN;
    // 通常のページ数（今回のCSVでは頁数=在庫の場合があるため、デフォルトはnull）
    let pages = null;

    const price = priceStr ? parseInt(String(priceStr).replace(/[^0-9]/g,'')) || null : null;

    // 在庫は stock 系が優先。無ければ頁数から導出
    let stock = 1;
    if (stockStr && String(stockStr).trim() !== '') {
      stock = parseInt(String(stockStr).replace(/[^0-9]/g,'')) || 1;
    } else if (!isNaN(pagesNumFromStr)) {
      stock = pagesNumFromStr || 1;
      pages = null; // 頁数列を在庫として使った場合はページ数は未設定
    }

    const acquisitionPrice = acquisitionPriceStr ? parseInt(String(acquisitionPriceStr).replace(/[^0-9]/g,'')) || null : null;
    const loanTotal = loanTotalStr ? parseInt(String(loanTotalStr).replace(/[^0-9]/g,'')) || 0 : 0;

    return {
      isbn13: extractIsbn13(isbnRaw),
      title,
      authors,
      publisher,
      published,
      series,
      pages,
      size,
      price,
      stock_count: stock,
      category: getFirst(row, ['category','分類','ジャンル']),
      notes: getFirst(row, ['notes','備考','メモ','注記']),
      // 追加フィールド
      status,
      copy_type: copyType,
      accession_number: accessionNumber,
      call_number: callNumber,
      material_type: materialType || '図書',
      acquisition_type: acquisitionType,
      acquisition_price: acquisitionPrice,
      acquisition_date: acquisitionDate || '',
      current_location: currentLocation,
      shelf_location: shelfLocation,
      temp_location: tempLocation,
      loan_policy: loanPolicy || '',
      loan_total: loanTotal,
      tags: parseTags(tagsStr)
    };
  }

  async function importCsvData() {
    if (csvData.length === 0) {
      showActionResult('エラー', 'インポートするデータがありません', 'error');
      return;
    }

    // 失敗理由の内訳を集計
    const reasons = { missing_title: 0, permission: 0, error: 0 };
    const errorsDetail = [];

    showElement('importProgress', true);
    let imported = 0;
    let errors = 0;

    for (let i = 0; i < csvData.length; i++) {
      try {
        const mapped = mapCsvRow(csvData[i]);
        if (!mapped.title) {
          errors++; reasons.missing_title++;
          continue;
        }

        try {
          await registerBook(mapped);
          imported++;
        } catch (e){
          errors++;
          const msg = String(e?.message || e);
          if (/管理者権限|admin/i.test(msg)) { reasons.permission++; }
          else { reasons.error++; }
          if (errorsDetail.length < 10) {
            errorsDetail.push(`行${i+1}: ${escapeHtml(msg)}`);
          }
        }

      } catch (e) {
        errors++; reasons.error++;
        if (errorsDetail.length < 10) {
          errorsDetail.push(`行${i+1}: ${escapeHtml(e?.message || String(e))}`);
        }
      }

      const progress = ((i + 1) / csvData.length) * 100;
      $('importProgressFill').style.width = `${progress}%`;
      $('importProgressText').textContent = `${i + 1}/${csvData.length} 処理完了`;
    }

    showElement('importProgress', false);
    showActionResult('インポート完了', `成功: ${imported}件、失敗: ${errors}件`, imported > 0 ? 'success' : 'warning');

    // 詳細結果を表示
    const resEl = $('importResults');
    if (resEl) {
      let html = '';
      html += `<p>失敗内訳: タイトル欠落 ${reasons.missing_title}件, 権限エラー ${reasons.permission}件, その他 ${reasons.error}件</p>`;
      if (errorsDetail.length) {
        html += '<details><summary>最初の10件のエラー詳細</summary><ul>';
        html += errorsDetail.map(l => `<li>${l}</li>`).join('');
        html += '</ul></details>';
      }
      resEl.innerHTML = html;
    }

    clearCsvImport();
  }

  function clearCsvImport() {
    $('csvFileInput').value = '';
    csvData = [];
    showElement('csvPreview', false);
    $('csvPreviewTable').innerHTML = '';
  }
  
  function logout() {
    auth.signOut().then(() => {
      window.location.href = 'index.html';
    });
  }
  
  // 認証状態の監視は DOMContentLoaded 内に統一
  document.addEventListener('DOMContentLoaded', () => {
    const manualForm = $('manualBookForm');
    if (manualForm) {
      manualForm.addEventListener('submit', (e) => {
        e.preventDefault();
        submitManualBook();
      });
    }
  });
  
  // 公開関数
  window.verifyAdmin = verifyAdmin;
  window.showTab = showTab;
  window.startBookScanner = startBookScanner;
  window.stopBookScanner = stopBookScanner;
  window.handleBookScanResult = handleBookScanResult;
  window.registerScannedBook = registerScannedBook;
  window.clearScanResult = clearScanResult;
  window.fetchBookDataByIsbn = fetchBookDataByIsbn;
  window.clearManualForm = clearManualForm;
  window.processBatchIsbn = processBatchIsbn;
  window.updateBatchStock = updateBatchStock;
  window.registerBatchBooks = registerBatchBooks;
  window.clearBatchList = clearBatchList;
  window.previewCsvFile = previewCsvFile;
  window.importCsvData = importCsvData;
  window.clearCsvImport = clearCsvImport;
  window.logout = logout;
  window.showAdminManagement = showAdminManagement;
  window.setUserAsAdmin = setUserAsAdmin;
  window.removeAdminPermission = removeAdminPermission;
  window.addNewAdmin = addNewAdmin;
  window.removeAdmin = removeAdmin;
  window.escapeHtml = escapeHtml;
  window.setupInitialAdmin = setupInitialAdmin;
  window.backfillSearchIndex = backfillSearchIndex;

  // 初期化処理
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await waitForFirebase();
      console.log('Firebase initialized successfully');
      
      // 認証状態の監視（ここだけに統一）
      auth.onAuthStateChanged(async (user) => {
        if (user) {
          setText('userInfo', `ログイン中: ${user.email}`);
          // 自動で管理者権限チェック
          await verifyAdmin();
        } else {
          window.location.href = 'login.html';
        }
      });
      
    } catch (error) {
      console.error('Firebase initialization error:', error);
      showMessage('adminAuthMsg', 'システムの初期化に失敗しました', 'error');
    }
  });

  // ===== 貸出状況ダッシュボード =====
  let __loansCache = [];
  let __loansResolved = [];

  function fmtDate(val){
    if (!val) return '-';
    const d = val?.toDate ? val.toDate() : (val instanceof Date ? val : new Date(val));
    if (!d || isNaN(d.getTime())) return '-';
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), da=String(d.getDate()).padStart(2,'0');
    return `${y}/${m}/${da}`;
  }
  function daysDiff(from, to){
    const a = (from?.toDate ? from.toDate() : new Date(from));
    const b = (to?.toDate ? to.toDate() : new Date(to));
    if (!a || !b || isNaN(a) || isNaN(b)) return 0;
    return Math.floor((b - a) / (1000*60*60*24));
  }

  async function fetchLoans(status){
    const col = db.collection('loans');
    const limitN = 500;
    let snaps = [];
    if (status === 'all') {
      const [a, r] = await Promise.all([
        col.where('status','==','active').limit(limitN).get(),
        col.where('status','==','returned').limit(limitN).get()
      ]);
      snaps = [...a.docs, ...r.docs];
    } else {
      const s = await col.where('status','==', status).limit(limitN).get();
      snaps = s.docs;
    }
    __loansCache = snaps.map(d => ({ id: d.id, ...d.data() }));
    return __loansCache;
  }

  async function resolveJoins(loans){
    // 収集
    const userIds = new Set();
    const bookIds = new Set();
    for (const l of loans){
      const uid = l.uid || l.user_id; if (uid) userIds.add(uid);
      const bid = l.book_id || l.book_ref; if (bid) bookIds.add(bid);
    }
    // 並列取得
    const userMap = new Map();
    const bookMap = new Map();
    await Promise.all([
      (async ()=>{
        await Promise.all([...userIds].map(async (uid)=>{
          try {
            const snap = await db.collection('users').doc(uid).get();
            if (snap.exists) userMap.set(uid, snap.data());
          } catch(e){ /* ignore */ }
        }));
      })(),
      (async ()=>{
        await Promise.all([...bookIds].map(async (bid)=>{
          try {
            const snap = await db.collection('books').doc(bid).get();
            if (snap.exists) bookMap.set(bid, { id: snap.id, ...snap.data() });
          } catch(e){ /* ignore */ }
        }));
      })()
    ]);

    // 合成
    __loansResolved = loans.map(l => {
      const uid = l.uid || l.user_id || '';
      const bid = l.book_id || l.book_ref || '';
      const u = userMap.get(uid) || {};
      const b = bookMap.get(bid) || {};
      const title = l.book_title || b.title || '';
      const isbn = b.isbn13 || b.isbn || l.isbn13 || '';
      const checked = l.checked_out_at || l.created_at || null;
      const due = l.due_at || null;
      const returned = l.returned_at || null;
      const status = l.status || (returned ? 'returned' : 'active');
      const overdue = status === 'active' && due && ( (due?.toDate ? due.toDate() : new Date(due)) < new Date() );
      return {
        id: l.id,
        status,
        overdue,
        user_id: u.user_id || uid,
        user_name: u.name || u.display_name || u.email || '',
        book_id: b.id || bid,
        title,
        isbn,
        call_number: b.call_number || '',
        accession_number: b.accession_number || '',
        checked_out_at: checked,
        due_at: due,
        returned_at: returned
      };
    });
    return __loansResolved;
  }

  function renderLoansTable(rows){
    const container = $('loansTableContainer');
    const summaryEl = $('loansSummary');
    if (!container) return;

    // サマリ
    const total = rows.length;
    const active = rows.filter(r=>r.status==='active').length;
    const overdue = rows.filter(r=>r.overdue).length;
    if (summaryEl) summaryEl.innerHTML = `総件数: ${total} / 貸出中: ${active} / 延滞: <span style="color:#c62828;">${overdue}</span>`;

    if (!rows.length) { container.innerHTML = '<p>該当する貸出はありません。</p>'; return; }

    const header = `
      <table class="preview-table">
        <thead>
          <tr>
            <th>利用者</th>
            <th>書名 / ISBN</th>
            <th>貸出日</th>
            <th>返却期限</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
    `;
    const body = rows.map(r => {
      const name = escapeHtml(`${r.user_name || '-'} (${r.user_id || '-'})`);
      const book = `${escapeHtml(r.title || '-')}${r.isbn ? `<br><small>${escapeHtml(r.isbn)}</small>` : ''}`;
      const dueTxt = fmtDate(r.due_at);
      const statusTxt = r.status==='active' ? (r.overdue ? '<span style="color:#c62828;">延滞</span>' : '貸出中') : '返却済み';
      return `
        <tr>
          <td>${name}</td>
          <td>${book}</td>
          <td>${fmtDate(r.checked_out_at)}</td>
          <td>${dueTxt}</td>
          <td>${statusTxt}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = header + body + '</tbody></table>';
  }

  function filterSearch(rows){
    const term = ($('loanSearchTerm')?.value || '').trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(r => {
      return (
        String(r.user_name||'').toLowerCase().includes(term) ||
        String(r.user_id||'').toLowerCase().includes(term) ||
        String(r.title||'').toLowerCase().includes(term) ||
        String(r.isbn||'').toLowerCase().includes(term) ||
        String(r.call_number||'').toLowerCase().includes(term) ||
        String(r.accession_number||'').toLowerCase().includes(term)
      );
    });
  }

  function applyOverdueFilter(rows){
    const only = $('loanOverdueOnly')?.checked;
    if (!only) return rows;
    return rows.filter(r => r.overdue);
  }

  async function refreshLoans(){
    try {
      const status = $('loanStatusFilter')?.value || 'active';
      showActionResult('処理中', '貸出データを読み込み中...', 'processing');
      const loans = await fetchLoans(status);
      const resolved = await resolveJoins(loans);
      let rows = resolved.slice();
      // クライアントで並び替え（延滞優先 / 貸出日降順）
      rows.sort((a,b)=>{
        const ao = a.overdue ? 1 : 0, bo = b.overdue ? 1 : 0;
        if (ao !== bo) return bo - ao;
        const at = (a.checked_out_at?.toDate ? a.checked_out_at.toDate().getTime() : new Date(a.checked_out_at||0).getTime());
        const bt = (b.checked_out_at?.toDate ? b.checked_out_at.toDate().getTime() : new Date(b.checked_out_at||0).getTime());
        return bt - at;
      });
      rows = filterSearch(rows);
      rows = applyOverdueFilter(rows);
      renderLoansTable(rows);
    } catch (e){
      console.error(e);
      showActionResult('エラー', '貸出状況の読み込みに失敗しました。', 'error');
    }
  }

  function exportLoansCsv(){
    const table = document.querySelector('#loansTableContainer table');
    if (!table){ showActionResult('エクスポート対象がありません', 'error'); return; }

    // 表からデータ化（現在の表示をそのまま）
    const rows = [];
    const trs = table.querySelectorAll('tbody tr');
    trs.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      rows.push({
        user: tds[0]?.innerText || '',
        book: tds[1]?.innerText || '',
        checked_out: tds[2]?.innerText || '',
        due_at: tds[3]?.innerText || '',
        status: tds[4]?.innerText || ''
      });
    });

    const csv = (window.Papa && Papa.unparse) ? Papa.unparse(rows) :
      ['user,book,checked_out,due_at,status']
        .concat(rows.map(r => [r.user,r.book,r.checked_out,r.due_at,r.status]
        .map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')))
        .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loans_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function initLoansDashboard(){
    refreshLoans();
  }

  // 公開
  window.initLoansDashboard = initLoansDashboard;
  window.refreshLoans = refreshLoans;
  window.exportLoansCsv = exportLoansCsv;
})();